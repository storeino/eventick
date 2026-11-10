import { Route, Routes } from "react-router-dom";
import Home from "./screens/Home";
import Explorer from "./screens/Explorer";
import EventDetail from "./screens/EventDetail";
import Checkout from "./screens/Checkout";
import Confirmation from "./screens/Confirmation";
import Billets from "./screens/Billets";
import TicketDetail from "./screens/TicketDetail";
import ClaimShare from "./screens/ClaimShare";
import BuyResale from "./screens/BuyResale";
import Resales from "./screens/Resales";
import Login from "./screens/Login";
import ResetPassword from "./screens/ResetPassword";
import Organiser from "./screens/Organiser";
import BecomeOrganiser from "./screens/BecomeOrganiser";
import Pro from "./screens/pro/Pro";
import Help from "./screens/Help";
import Legal from "./screens/Legal";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/explorer" element={<Explorer />} />
      <Route path="/evenements/:slug" element={<EventDetail />} />
      <Route path="/paiement" element={<Checkout />} />
      <Route path="/confirmation/:orderId" element={<Confirmation />} />
      <Route path="/billets" element={<Billets />} />
      <Route path="/billet/:ticketId" element={<TicketDetail />} />
      {/* Public: the token is the credential, so a recipient with no account
          can claim a ticket someone gave them. */}
      <Route path="/billet-offert/:token" element={<ClaimShare />} />
      {/* A resale link. Public to OPEN — the buyer has to see what is on
          offer before deciding — but buying needs an account, which the
          screen asks for rather than the route. */}
      <Route path="/revente/:token" element={<BuyResale />} />
      {/* The marketplace: every seat on resale, for someone who found a show
          sold out and wants to know whether anyone is selling. */}
      <Route path="/reventes" element={<Resales />} />
      <Route path="/login" element={<Login />} />
      {/* The token is in the PATH, not a query string, so it does not leak
          through a Referer header when this page loads a font or an icon. */}
      <Route path="/mot-de-passe/:token" element={<ResetPassword />} />
      <Route path="/organiser" element={<Organiser />} />
      <Route path="/devenir-organisateur" element={<BecomeOrganiser />} />
      <Route path="/pro/*" element={<Pro />} />
      <Route path="/aide" element={<Help />} />
      <Route path="/legal" element={<Legal />} />
    </Routes>
  );
}
