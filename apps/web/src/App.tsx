import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { Mark, ToastProvider } from "@openportrait/ui";
import { SessionProvider, useSession } from "./lib/session.js";
import { Shell } from "./Shell.js";
import { SetupPage } from "./pages/Setup.js";
import { LoginPage } from "./pages/Login.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { ComingSoonPage } from "./pages/ComingSoon.js";
import { SettingsLayout } from "./pages/settings/SettingsLayout.js";
import { StudioSettingsPage } from "./pages/settings/Studio.js";
import { InternetSettingsPage } from "./pages/settings/Internet.js";
import { ConnectAISettingsPage } from "./pages/settings/ConnectAI.js";
import { AccountSettingsPage } from "./pages/settings/Account.js";
import { ShootSettingsPage } from "./pages/settings/Shoots.js";
import { ClientsPage } from "./pages/clients/Clients.js";
import { ContactDetailPage } from "./pages/clients/ContactDetail.js";
import { LeadsPage } from "./pages/leads/Leads.js";
import { LeadDetailPage } from "./pages/leads/LeadDetail.js";
import { ShootsPage } from "./pages/shoots/Shoots.js";
import { ShootDetailPage } from "./pages/shoots/ShootDetail.js";
import { CalendarPage } from "./pages/calendar/Calendar.js";
import { CalendarSettingsPage } from "./pages/settings/Calendar.js";
import { EmailSettingsPage } from "./pages/settings/Email.js";
import { BookingPage } from "./pages/booking/Booking.js";
import { InquirePage } from "./pages/public/Inquire.js";
import { BookPage } from "./pages/public/Book.js";
import { BookCancelPage } from "./pages/public/BookCancel.js";
import { NotFoundPage } from "./pages/NotFound.js";

function Boot() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading OpenPortrait">
      <Mark size={40} />
    </div>
  );
}

/** Sends people to setup, sign-in, or the app depending on where things stand. */
function Gate({ need }: { need: "setup" | "anon" | "user" }) {
  const { loading, needsSetup, me } = useSession();
  const location = useLocation();
  if (loading) return <Boot />;
  if (needsSetup && need !== "setup") return <Navigate to="/studio/setup" replace />;
  if (!needsSetup && need === "setup") return <Navigate to={me?.user ? "/studio" : "/studio/login"} replace />;
  if (need === "user" && !me?.user) return <Navigate to="/studio/login" replace state={{ from: location.pathname }} />;
  if (need === "anon" && me?.user) return <Navigate to="/studio" replace />;
  return <Outlet />;
}

export function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/studio" replace />} />
            <Route path="/studio">
              <Route element={<Gate need="setup" />}>
                <Route path="setup" element={<SetupPage />} />
              </Route>
              <Route element={<Gate need="anon" />}>
                <Route path="login" element={<LoginPage />} />
              </Route>
              <Route element={<Gate need="user" />}>
                <Route element={<Shell />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="leads" element={<LeadsPage />} />
                  <Route path="leads/:id" element={<LeadDetailPage />} />
                  <Route path="shoots" element={<ShootsPage />} />
                  <Route path="shoots/:id" element={<ShootDetailPage />} />
                  <Route path="calendar" element={<CalendarPage />} />
                  <Route path="booking" element={<BookingPage />} />
                  <Route path="clients" element={<ClientsPage />} />
                  <Route path="clients/:id" element={<ContactDetailPage />} />
                  <Route path="orders" element={<ComingSoonPage area="orders" />} />
                  <Route path="galleries" element={<ComingSoonPage area="galleries" />} />
                  <Route path="incoming" element={<ComingSoonPage area="incoming" />} />
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="studio" replace />} />
                    <Route path="studio" element={<StudioSettingsPage />} />
                    <Route path="shoots" element={<ShootSettingsPage />} />
                    <Route path="calendar" element={<CalendarSettingsPage />} />
                    <Route path="email" element={<EmailSettingsPage />} />
                    <Route path="internet" element={<InternetSettingsPage />} />
                    <Route path="ai" element={<ConnectAISettingsPage />} />
                    <Route path="account" element={<AccountSettingsPage />} />
                  </Route>
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="/inquire" element={<InquirePage />} />
            <Route path="/book/cancel/:token" element={<BookCancelPage />} />
            <Route path="/book/:slug" element={<BookPage />} />
            <Route path="*" element={<NotFoundPage standalone />} />
          </Routes>
        </BrowserRouter>
      </SessionProvider>
    </ToastProvider>
  );
}
