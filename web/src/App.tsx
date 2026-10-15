import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { DataQualityPage } from '@/pages/DataQualityPage';
import { DeductionsPage } from '@/pages/DeductionsPage';
import { DisputesPage } from '@/pages/DisputesPage';
import { LoginPage } from '@/pages/LoginPage';
import { OverviewPage } from '@/pages/OverviewPage';
import { SessionProvider, useSession } from '@/lib/session';

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { session } = useSession();
  return session.canSeeUnassigned ? children : <Navigate to="/" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <SessionProvider>
            <AppShell />
          </SessionProvider>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="deductions" element={<DeductionsPage />} />
        <Route path="disputes" element={<DisputesPage />} />
        <Route path="data-quality" element={<DataQualityPage />} />
        <Route
          path="unassigned"
          element={
            <AdminOnly>
              <DeductionsPage key="unassigned" mode="unassigned" />
            </AdminOnly>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
