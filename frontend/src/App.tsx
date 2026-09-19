import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { ClassifyPage } from './pages/ClassifyPage';
import { HistoryPage } from './pages/HistoryPage';

function navClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'nav-link nav-link--active' : 'nav-link';
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="app__header">
          <div className="app__brand">
            <span className="app__logo" aria-hidden="true">
              ✊
            </span>
            <div>
              <p className="app__title">Rock · Paper · Scissors</p>
              <p className="app__subtitle">ResNet18 classifier</p>
            </div>
          </div>

          <nav className="app__nav" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              Classify
            </NavLink>
            <NavLink to="/history" className={navClass}>
              History
            </NavLink>
          </nav>
        </header>

        <main className="app__main">
          <Routes>
            <Route path="/" element={<ClassifyPage />} />
            <Route path="/history" element={<HistoryPage />} />
            {/* Any unknown path goes home. `replace` keeps the bad URL out of
                the history stack, so Back does not return to a 404. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <footer className="app__footer">
          <p>
            React · Express · RabbitMQ · PostgreSQL · LocalStack · PyTorch — the browser never
            waits on the model.
          </p>
        </footer>
      </div>
    </BrowserRouter>
  );
}
