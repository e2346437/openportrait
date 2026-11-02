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
import { AutomationSettingsPage } from "./pages/settings/Automation.js";
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
import { CameraUploadSettingsPage } from "./pages/settings/CameraUpload.js";
import { BookingPage } from "./pages/booking/Booking.js";
import { InquirePage } from "./pages/public/Inquire.js";
import { BookPage } from "./pages/public/Book.js";
import { BookCancelPage } from "./pages/public/BookCancel.js";
import { ApprovalsPage } from "./pages/Approvals.js";
import { ConsentAIPage } from "./pages/ConsentAI.js";
import { OrdersPage } from "./pages/orders/Orders.js";
import { ContractsPage } from "./pages/contracts/Contracts.js";
import { ContractPage } from "./pages/contracts/Contract.js";
import { ContractTemplatesPage } from "./pages/settings/ContractTemplates.js";
import { ContractSignPage } from "./pages/public/Contract.js";
import { OrderPage } from "./pages/orders/Order.js";
import { QuestionnairesSettingsPage } from "./pages/settings/Questionnaires.js";
import { QuestionnairePage } from "./pages/public/Questionnaire.js";
import { ImportSettingsPage } from "./pages/settings/Import.js";
import { PricesSettingsPage } from "./pages/settings/Prices.js";
import { ExtensionPageView } from "./pages/extensions/ExtensionPage.js";
import { ExtensionsSettingsPage } from "./pages/settings/Extensions.js";
import { PaymentsSettingsPage } from "./pages/settings/Payments.js";
import { OrderViewPage } from "./pages/public/Order.js";
import { NotFoundPage } from "./pages/NotFound.js";
import { GalleriesListPage } from "./pages/galleries/GalleriesList.js";
import { GalleryDetailPage } from "./pages/galleries/GalleryDetail.js";
import { GallerySettingsPage } from "./pages/settings/Galleries.js";
import { ClientGalleryPage } from "./pages/client/ClientGallery.js";
import "./pages/client/client.css";
import "./pages/galleries/galleries.css";
import { IncomingPage } from "./pages/incoming/Incoming.js";
import { TetherSetupPage } from "./pages/tether/TetherSetup.js";
import { TetherLivePage } from "./pages/tether/TetherLive.js";

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
  if (need === "user" && !me?.user) return <Navigate to="/studio/login" replace state={{ from: location.pathname + location.search }} />;
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
                <Route path="connect/consent" element={<ConsentAIPage />} />
                <Route path="tether/:source" element={<TetherLivePage />} />
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
                  <Route path="contracts" element={<ContractsPage />} />
                  <Route path="contracts/:id" element={<ContractPage />} />
                  <Route path="orders" element={<OrdersPage />} />
                  <Route path="orders/new" element={<OrderPage />} />
                  <Route path="orders/:id" element={<OrderPage />} />
                  <Route path="galleries" element={<GalleriesListPage />} />
                  <Route path="galleries/:id" element={<GalleryDetailPage />} />
                  <Route path="incoming" element={<IncomingPage />} />
                  <Route path="tether" element={<TetherSetupPage />} />
                  <Route path="approvals" element={<ApprovalsPage />} />
                  <Route path="x/:extension/:slug" element={<ExtensionPageView />} />
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="studio" replace />} />
                    <Route path="studio" element={<StudioSettingsPage />} />
                    <Route path="galleries" element={<GallerySettingsPage />} />
                    <Route path="shoots" element={<ShootSettingsPage />} />
                    <Route path="calendar" element={<CalendarSettingsPage />} />
                    <Route path="questionnaires" element={<QuestionnairesSettingsPage />} />
                    <Route path="prices" element={<PricesSettingsPage />} />
                    <Route path="payments" element={<PaymentsSettingsPage />} />
                    <Route path="contracts" element={<ContractTemplatesPage />} />
                    <Route path="email" element={<EmailSettingsPage />} />
                    <Route path="camera-upload" element={<CameraUploadSettingsPage />} />
                    <Route path="internet" element={<InternetSettingsPage />} />
                    <Route path="automation" element={<AutomationSettingsPage />} />
                    <Route path="ai" element={<ConnectAISettingsPage />} />
                    <Route path="extensions" element={<ExtensionsSettingsPage />} />
                    <Route path="import" element={<ImportSettingsPage />} />
                    <Route path="account" element={<AccountSettingsPage />} />
                  </Route>
                  <Route path="*" element={<NotFoundPage />} />
                </Route>
              </Route>
            </Route>
            <Route path="/g/:slug" element={<ClientGalleryPage />} />
            <Route path="/inquire" element={<InquirePage />} />
            <Route path="/q/:token" element={<QuestionnairePage />} />
            <Route path="/o/:token" element={<OrderViewPage />} />
            <Route path="/c/:token" element={<ContractSignPage />} />
            <Route path="/book/cancel/:token" element={<BookCancelPage />} />
            <Route path="/book/:slug" element={<BookPage />} />
            <Route path="*" element={<NotFoundPage standalone />} />
          </Routes>
        </BrowserRouter>
      </SessionProvider>
    </ToastProvider>
  );
}
