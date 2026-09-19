/**
 * The publishing half of the queue. The consuming half is inference/worker.py.
 *
 * This service never runs inference and never spawns a process: it hands a job
 * to RabbitMQ and returns. That is the whole point of the architecture -- a
 * forward pass through ResNet18 takes as long as it takes, and an HTTP request
 * that waited for it would hold a connection open, occupy a socket, and still
 * time out under load. Publishing takes milliseconds and always will.
 *
 * ## Topology
 *
 *   inference.jobs ──(rejected)──▶ inference.dlx ──▶ inference.jobs.failed
 *
 * A message the worker rejects is dead-lettered instead of discarded, so a
 * failure leaves evidence in the broker as well as a row in Postgres.
 *
 * Both this file and inference/worker.py declare that topology, and the two
 * declarations must agree exactly: RabbitMQ answers a redeclaration with
 * different arguments with PRECONDITION_FAILED and closes the channel. Either
 * side may legitimately start first, which is why neither can be the only one
 * to declare it.
 */

import { once } from 'node:events';

import { connect, type ChannelModel, type ConfirmChannel, type RecoveringChannelModel } from 'amqplib';

import { env } from '../config/env';
import type { InferenceJobMessage } from '../models/types';
import { createLogger, describeError } from '../utils/logger';

const log = createLogger('queue');

/** Structural type satisfied by both a plain and a recovering channel model. */
type ChannelSource = Pick<ChannelModel, 'createConfirmChannel'>;

export class QueueService {
  private model: RecoveringChannelModel | null = null;
  private channel: ConfirmChannel | null = null;

  /**
   * Opens the connection and declares the topology.
   *
   * amqplib's `recovery` option does the reconnection work: the returned
   * promise settles only once the first connection succeeds, and afterwards
   * the model reconnects on its own with exponential backoff and jitter,
   * re-running `setup` each time. A hand-written retry loop here would be
   * strictly worse -- it would cover startup but not a broker restart three
   * hours later.
   */
  async connect(): Promise<void> {
    this.model = await connect(env.rabbit.url, {
      recovery: {
        initialDelay: 1_000,
        maxDelay: 15_000,
        factor: 2,
        jitter: 0.2,
        // Finite, so a broker that never appears eventually fails the boot
        // loudly instead of leaving the container hanging forever.
        maxRetries: 60,
        // Annotated because `setup` is declared as a union of a promise-
        // returning and a callback-style signature, and TypeScript cannot
        // contextually infer a parameter across overload shapes.
        setup: async (model: ChannelModel): Promise<void> => {
          this.channel = await this.openChannel(model);
        },
      },
    });

    this.model.on('connect', () => log.info('connected'));
    this.model.on('disconnect', (error) => {
      // The channel died with the connection; drop it so nothing publishes
      // through a dead one while recovery is still in progress.
      this.channel = null;
      log.warn(`disconnected: ${describeError(error)}`);
    });
    this.model.on('reconnect-scheduled', ({ attempt, delay }) => {
      log.warn(`reconnect attempt ${attempt} in ${delay}ms`);
    });
    this.model.on('error', (error) => log.error('connection error', error));

    log.info(`publishing to "${env.rabbit.queue}"`);
  }

  /**
   * Publishes a job and waits for the broker to confirm it.
   *
   * The confirmation is the point. `sendToQueue` only means "written to a
   * socket"; without `waitForConfirms` the API could answer 202 Accepted for a
   * message that RabbitMQ never accepted, and the upload would vanish with the
   * user watching a spinner. Waiting costs a round trip and makes the 202
   * truthful.
   */
  async publishJob(job: InferenceJobMessage): Promise<void> {
    const channel = await this.requireChannel();
    const payload = Buffer.from(JSON.stringify(job), 'utf8');

    const accepted = channel.sendToQueue(env.rabbit.queue, payload, {
      // Survives a broker restart, which a durable queue alone does not
      // guarantee: the queue would come back empty without this.
      persistent: true,
      contentType: 'application/json',
      messageId: job.requestId,
      timestamp: Date.now(),
      appId: 'rps-backend',
    });

    if (!accepted) {
      // The channel's write buffer is full. Publishing anyway would grow the
      // heap without bound, so wait for it to drain instead.
      log.warn('publish buffer full, waiting for drain');
      await once(channel, 'drain');
    }

    await channel.waitForConfirms();
  }

  /** Readiness probe: the queue is reachable and still declared. */
  async ping(): Promise<void> {
    const channel = await this.requireChannel();
    await channel.checkQueue(env.rabbit.queue);
  }

  async close(): Promise<void> {
    try {
      await this.channel?.close();
      await this.model?.close();
      log.info('connection closed');
    } catch (error) {
      // Shutdown only. A broker that is already gone is not worth a non-zero
      // exit code.
      log.warn(`error while closing: ${describeError(error)}`);
    } finally {
      this.channel = null;
      this.model = null;
    }
  }

  /**
   * Returns a live channel, rebuilding it if the previous one is gone.
   *
   * A channel can die on its own while the connection stays healthy -- a
   * channel-level protocol error closes it and nothing else. Connection
   * recovery would not notice that, so `publishJob` would fail forever
   * afterwards. Recreating lazily here makes that self-healing.
   */
  private async requireChannel(): Promise<ConfirmChannel> {
    if (this.channel) {
      return this.channel;
    }
    if (!this.model) {
      throw new Error('QueueService.connect() has not been called');
    }
    this.channel = await this.openChannel(this.model);
    return this.channel;
  }

  private async openChannel(source: ChannelSource): Promise<ConfirmChannel> {
    const channel = await source.createConfirmChannel();

    // Where rejected messages are routed. Declared before the queue that
    // names it so the reference is never dangling.
    await channel.assertExchange(env.rabbit.deadLetterExchange, 'direct', { durable: true });
    await channel.assertQueue(env.rabbit.deadLetterQueue, { durable: true });
    await channel.bindQueue(
      env.rabbit.deadLetterQueue,
      env.rabbit.deadLetterExchange,
      DEAD_LETTER_ROUTING_KEY,
    );

    await channel.assertQueue(env.rabbit.queue, {
      // Durable queue + persistent messages: jobs outlive a broker restart.
      durable: true,
      deadLetterExchange: env.rabbit.deadLetterExchange,
      deadLetterRoutingKey: DEAD_LETTER_ROUTING_KEY,
    });

    channel.on('error', (error) => log.error('channel error', error));
    channel.on('close', () => {
      this.channel = null;
      log.warn('channel closed');
    });

    return channel;
  }
}

/**
 * Must match DEAD_LETTER_ROUTING_KEY in inference/worker.py. It is a literal
 * rather than an environment variable because it is only ever meaningful as
 * one half of a matched pair, and two knobs that must always be turned
 * together are better as no knob at all.
 */
const DEAD_LETTER_ROUTING_KEY = 'failed';
