import { Route, Routes, useLocation } from 'react-router-dom';
import Layout from '@/components/Layout';
import ErrorBoundary from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/Toast';
import { useTheme } from '@/hooks/useTheme';
import { useSanctionsFeed } from '@/hooks/useSanctionsFeed';
import HomePage from '@/pages/HomePage';
import SearchPage from '@/pages/SearchPage';
import AddressPage from '@/pages/AddressPage';
import TxPage from '@/pages/TxPage';
import TracePage from '@/pages/TracePage';
import CasesPage from '@/pages/CasesPage';
import SettingsPage from '@/pages/SettingsPage';
import AboutPage from '@/pages/AboutPage';
import NotFoundPage from '@/pages/NotFoundPage';
import '@/styles/components.css';

/** App-wide side effects: theme on `<html>`, sanctions feed warm-up (when enabled in Settings). */
function Bootstrap() {
  useTheme();
  useSanctionsFeed();
  return null;
}

export default function App() {
  const { pathname } = useLocation();
  return (
    <ToastProvider>
      <Bootstrap />
      <Layout>
        {/* Keyed by path so a crashed page recovers on navigation. */}
        <ErrorBoundary key={pathname}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search/:query" element={<SearchPage />} />
            <Route path="/address/:chain/:address" element={<AddressPage />} />
            <Route path="/tx/:chain/:hash" element={<TxPage />} />
            <Route path="/trace/:chain/:address" element={<TracePage />} />
            <Route path="/cases" element={<CasesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
      </Layout>
    </ToastProvider>
  );
}
