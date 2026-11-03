import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { Activity, CalendarDays, KeyRound, LayoutDashboard, LayoutGrid, MailPlus, QrCode, ReceiptText, ScrollText, ShieldCheck, Tag, Tags, Wallet } from "lucide-react";
import { Protected } from "../../components/Protected";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { useI18n } from "../../i18n";
import { ConfirmProvider } from "./ConfirmContext";
import DashboardShell from "./chrome/DashboardShell";
import { text } from "./copy";
import Overview from "./Overview";
import Events from "./Events";
import Orders from "./Orders";
import OrderDetail from "./OrderDetail";
import Gate from "./Gate";
import Finance from "./Finance";
import Offers from "./Offers";
import Resales from "./Resales";
import Placements from "./Placements";
import Invitations from "./Invitations";
import Users from "./Users";
import Permissions from "./Permissions";
import Platform from "./Platform";
import Journal from "./Journal";

const ic = (Icon) => <Icon size={19} strokeWidth={2} aria-hidden />;

function ProInner() {
  const { locale } = useI18n();
  const t = text[locale];
  const { can } = useAuth();
  const [todayCount, setTodayCount] = useState(0);

  // Badge on Réservations: tickets still to be scanned for events happening today.
  useEffect(() => {
    let alive = true;
    api
      .get("/organiser/orders/detailed")
      .then((data) => {
        if (!alive) return;
        const today = new Date().toISOString().slice(0, 10);
        const pending = data.orders
          .flatMap((order) => order.tickets)
          .filter((ticket) => ticket.status === "VALID" && ticket.event.start.slice(0, 10) === today).length;
        setTodayCount(pending);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Each item names the capability its screen needs, and filters itself out
  // when the viewer lacks it. The backend enforces the same list per route
  // (see organiser.ts), so without this an admin revoking finance.view would
  // leave "Finance" in the sidebar pointing at a page that 403s on load —
  // the menu promising something the server refuses.
  //
  // `permission: null` means "anyone who can reach /pro at all": Pilotage is
  // the landing screen, and the route guard already requires events.manage.
  const sections = [
    { group: t.grpPilotage, to: "/pro", end: true, label: t.overview, icon: ic(LayoutDashboard), permission: null },
    { group: t.grpPilotage, to: "/pro/orders", label: t.orders, icon: ic(ReceiptText), badge: todayCount, permission: "orders.manage" },
    { group: t.grpCatalogue, to: "/pro/events", label: t.events, icon: ic(CalendarDays), permission: "events.manage" },
    { group: t.grpCatalogue, to: "/pro/placements", label: t.placements, icon: ic(LayoutGrid), permission: "events.manage" },
    { group: t.grpCatalogue, to: "/pro/invitations", label: t.invitations, icon: ic(MailPlus), permission: "events.manage" },
    { group: t.grpCatalogue, to: "/pro/offers", label: t.offers, icon: ic(Tags), permission: "promo.manage" },
    { group: t.grpCatalogue, to: "/pro/resales", label: t.resales, icon: ic(Tag), permission: "events.manage" },
    { group: t.grpOperations, to: "/pro/gate", label: t.gate, icon: ic(QrCode), permission: "gate.checkin" },
    { group: t.grpFinances, to: "/pro/finance", label: t.finance, icon: ic(Wallet), permission: "finance.view" },
    { group: t.grpAdmin, to: "/pro/platform", label: t.platform, icon: ic(Activity), permission: "scope.any" },
    { group: t.grpAdmin, to: "/pro/users", label: t.team, icon: ic(ShieldCheck), permission: "users.manage" },
    { group: t.grpAdmin, to: "/pro/permissions", label: t.permissions, icon: ic(KeyRound), permission: "users.manage" },
    // Same gate as the journal route and the API behind it: the rows describe
    // money and accounts across every organiser.
    { group: t.grpAdmin, to: "/pro/journal", label: t.journal, icon: ic(ScrollText), permission: "scope.any" },
  ].filter((item) => !item.permission || can(item.permission));

  return (
    <DashboardShell sections={sections}>
      <Routes>
        {/* Hiding a nav item is not access control: someone typing the path
            directly would otherwise render the screen and only find out from
            a string of 403s. Every route carries the same permission its
            sidebar entry does, so the guard holds whichever way they arrive. */}
        <Route index element={<Overview />} />
        <Route
          path="events"
          element={
            <Protected permission="events.manage">
              <Events />
            </Protected>
          }
        />
        <Route
          path="orders"
          element={
            <Protected permission="orders.manage">
              <Orders />
            </Protected>
          }
        />
        {/* Same permission as the list: a detail page that opened to someone
            who may not see the list would be a way around it. */}
        <Route
          path="orders/:orderId"
          element={
            <Protected permission="orders.manage">
              <OrderDetail />
            </Protected>
          }
        />
        <Route
          path="gate"
          element={
            <Protected permission="gate.checkin">
              <Gate />
            </Protected>
          }
        />
        <Route
          path="finance"
          element={
            <Protected permission="finance.view">
              <Finance />
            </Protected>
          }
        />
        <Route
          path="placements"
          element={
            <Protected permission="events.manage">
              <Placements />
            </Protected>
          }
        />
        <Route
          path="invitations"
          element={
            <Protected permission="events.manage">
              <Invitations />
            </Protected>
          }
        />
        <Route
          path="offers"
          element={
            <Protected permission="promo.manage">
              <Offers />
            </Protected>
          }
        />
        <Route
          path="resales"
          element={
            <Protected permission="events.manage">
              <Resales />
            </Protected>
          }
        />
        <Route
          path="platform"
          element={
            <Protected permission="scope.any">
              <Platform />
            </Protected>
          }
        />
        <Route
          path="users"
          element={
            <Protected permission="users.manage">
              <Users />
            </Protected>
          }
        />
        <Route
          path="journal"
          element={
            <Protected permission="scope.any">
              <Journal />
            </Protected>
          }
        />
        <Route
          path="permissions"
          element={
            <Protected permission="users.manage">
              <Permissions />
            </Protected>
          }
        />
      </Routes>
    </DashboardShell>
  );
}

export default function Pro() {
  return (
    <Protected permission="events.manage">
      <ConfirmProvider>
        <ProInner />
      </ConfirmProvider>
    </Protected>
  );
}
