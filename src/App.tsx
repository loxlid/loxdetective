import { Route, Routes } from 'react-router-dom';

/**
 * Placeholder shell. The UI stage replaces this with the real layout and
 * pages (see docs/SPEC.md §6).
 */
export default function App() {
  return (
    <Routes>
      <Route path="*" element={<main className="container"><h1>LoxDetective</h1><p>Loading…</p></main>} />
    </Routes>
  );
}
