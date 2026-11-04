import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Check, ChevronDown, LayoutDashboard, LogOut, MapPin, Menu, Moon, Search, Sun, Tag, Ticket, User, X } from "lucide-react";
import { useAuth } from "../../AuthContext";
import { useCart } from "../../CartContext";
import { useCatalog } from "../../useCatalog";
import { money } from "../../api";
import { categoryLabel, LOCALES, LOCALE_LABELS, useI18n } from "../../i18n";
import { useTheme } from "../../ThemeContext";
import { Button, IconButton, Input, Popover, PopoverItem } from "../../ui";
import { CITIES, cn, eventText, minPriceCents, monthBadge } from "../../utils";
import { EventTicker } from "./EventTicker";

/**
 * The public site header.
 *
 * The previous one put **20 controls** in a single bar — burger, logo, city
 * picker, five nav links, search, three language buttons, theme, a "MAD"
 * badge, cart, create, avatar and sign-out — all at roughly equal weight, so
 * nothing read as primary and the row overflowed into a scrollbar on a laptop.
 * Its city and search dropdowns had no Escape and no outside-click dismissal.
 *
 * The rebuild keeps one primary action visible (sign in, or the account) and
 * moves the per-session settings — language, theme, sign out — behind the
 * account popover, which is where people look for them. The "MAD" badge is
 * gone: every price on the site is already labelled MAD, so it was a
 * permanent pixel cost for information shown at the point of use.
 *
 * Shape v3: the brand lockup and the city picker are grouped as one visual
 * unit (a shared pill-shaped surface) instead of sitting as two independent
 * controls of equal weight next to the nav links — same "give the identity
 * its own space" move the dashboard's sidebar brand block got.
 *
 * Shape v4: the nav gets a real active state (a filled pill, not just a
 * hover), "Create" becomes the header's one deliberate brand-pink moment
 * (Button's `brand` variant — the one case that intentionally breaks the
 * "action pill, not brand colour" rule), and the account trigger grew a
 * ring + bolder avatar so it reads as a real identity control rather than
 * a bare initial in a circle.
 *
 * Shape v5: NAV dropped from 5 items to 3 — "Culture & Théâtre" and
 * "Espace Pro" were long enough to wrap onto a second line at common
 * laptop widths, which broke the header's fixed height. Pro moved into
 * the account popover and the mobile drawer instead of fighting the
 * other four items for room in a bar that was already full.
 */

// Trimmed from 5 to 3: "Culture & Théâtre" and "Espace Pro" were long enough
// to wrap onto a second line at common laptop widths, which broke the
// header's height. Pro is still reachable from the account menu and the
// mobile drawer below — just not fighting for room in the top bar.
//
// `key` must name the category it links to. The third item used to read
// "Concerts" while pointing at ?cat=humour, so clicking it opened theatre
// and comedy — there is no "concerts" category at all (the six are
// festivals, humour, sport, nightlife, culture, salons; see utils.js).
// Labels come from categoryLabel() for exactly that reason: it is keyed off
// the category id, so a link and its text cannot drift apart again.
//
// Resale is deliberately NOT here. It was added as a fourth item and taken
// back out: even as the shortest label in the bar it crowded the search
// field against the "Create an event" button, which is the one control the
// header exists to push. It lives in the account popover and the mobile
// drawer instead -- the same place Pro went, and for the same reason.
const NAV = [
  { to: "/explorer", key: "explore" },
  { to: "/explorer?cat=festivals", cat: "festivals" },
  { to: "/explorer?cat=nightlife", cat: "nightlife" },
];

/** A nav item's visible text: the category's own label, or a plain copy key. */
function navLabel(item, t) {
  return item.cat ? categoryLabel(item.cat, t) : t(item.key);
}

export function SiteHeader({ overlay = false }) {
  const { t, locale, setLocale } = useI18n();
  const { resolved, toggle } = useTheme();
  const { user, loading, logout, canUsePro } = useAuth();
  const { cart } = useCart();
  const { events } = useCatalog();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The mobile sheet is modal, so it gets the same treatment as a dialog.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event) => event.key === "Escape" && setMenuOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Transparent over a hero image until the page scrolls.
  const onImage = overlay && !scrolled;

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return events
      .filter((event) => `${event.titleFr} ${event.titleAr} ${event.city} ${event.venueFr}`.toLowerCase().includes(needle))
      .slice(0, 6);
  }, [events, query]);

  const cartCount = cart?.lines?.reduce((sum, line) => sum + line.qty, 0) ?? 0;

  /**
   * The city this header should SAY it is showing.
   *
   * It is read back out of the URL rather than held in state, because the URL
   * is where the filter actually lives: `goCity` navigates to
   * `/explorer?ville=…`, and the Explorer screen reads the same parameter. A
   * separate piece of header state would be a second copy of one fact, and
   * would go stale the moment someone arrives on a filtered link, uses the
   * back button, or changes the city from the Explorer page itself.
   *
   * Before this, the trigger was hardcoded to t("allMorocco") — so picking
   * Marrakech filtered the catalogue correctly while the control went on
   * claiming "Tout le Maroc", which reads as the click having been ignored.
   */
  const activeCity = (() => {
    const value = new URLSearchParams(search).get("ville");
    return value && CITIES.includes(value) ? value : null;
  })();

  const goCity = (city, close) => {
    close?.();
    setMenuOpen(false);
    navigate(city ? `/explorer?ville=${encodeURIComponent(city)}` : "/explorer");
  };

  const submitSearch = (close) => {
    close?.();
    if (query.trim()) navigate(`/explorer?q=${encodeURIComponent(query.trim())}`);
  };

  return (
    <header
      className={cn(
        "sticky top-0 z-40 border-b transition-colors duration-200",
        // onImage is deliberately always-dark, matching the dark hero it
        // floats over regardless of app theme -- stage, not encre/foam.
        onImage ? "border-transparent bg-stage/30 text-stage-fg backdrop-blur-md" : "border-line/10 bg-card/95 text-ink backdrop-blur",
      )}
    >
      <EventTicker events={events} onImage={onImage} />

      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4 md:px-8">
        <IconButton
          label={t("openMenu")}
          size="sm"
          tone={onImage ? "inverse" : "neutral"}
          className="lg:hidden"
          onClick={() => setMenuOpen(true)}
        >
          <Menu className="size-5" />
        </IconButton>

        {/* Brand + city as one visual unit, not two independent pills of
            equal weight — the mark gets a tile, the city rides inside the
            same rounded surface as a quiet second control. */}
        <div
          className={cn(
            "flex items-center gap-1 rounded-full py-1 ps-1 pe-1.5 transition",
            onImage ? "bg-stage-fg/10" : "bg-paper",
          )}
        >
          <Link to="/" className="flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5 font-display text-lg font-extrabold tracking-tight">
            <span
              className={cn(
                "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[13px]",
                onImage ? "bg-accent text-accent-fg" : "bg-primary text-primary-fg",
              )}
              aria-hidden
            >
              E
            </span>
            <span className="hidden sm:inline">Eventick.ma</span>
          </Link>

          <Popover
            label={activeCity ?? t("allMorocco")}
            className="hidden md:block"
            width="w-56"
            trigger={({ open }) => (
              <span
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-sm font-semibold transition",
                  onImage ? "hover:bg-stage-fg/15" : "hover:bg-brume",
                )}
              >
                <MapPin className={cn("size-4", onImage ? "text-accent" : "text-primary")} aria-hidden />
                {activeCity ?? t("allMorocco")}
                <ChevronDown className={cn("size-4 transition", open && "rotate-180")} aria-hidden />
              </span>
            )}
          >
            {({ close }) => (
              <div className="scroll-thin max-h-80 overflow-y-auto py-1.5">
                {/* The current choice is ticked, the same way the Dropdown
                    primitive marks its own — without it the open list gives
                    no clue which city you are already filtered to. */}
                <PopoverItem onClick={() => goCity("", close)} className="justify-between">
                  {t("allMorocco")}
                  {!activeCity ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                </PopoverItem>
                {CITIES.map((city) => (
                  <PopoverItem key={city} onClick={() => goCity(city, close)} className="justify-between">
                    {city}
                    {activeCity === city ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
                  </PopoverItem>
                ))}
              </div>
            )}
          </Popover>
        </div>

        <nav aria-label={t("explore")} className="ms-2 hidden items-center gap-1 lg:flex">
          {NAV.map((item) => {
            const active = `${pathname}${search}` === item.to || (item.to === "/explorer" && pathname === "/explorer" && !search);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-semibold transition",
                  active
                    ? onImage
                      ? "bg-stage-fg/15 text-stage-fg"
                      : "bg-paper text-ink"
                    : onImage
                      ? "text-stage-fg/80 hover:bg-stage-fg/10 hover:text-stage-fg"
                      : "text-muted hover:bg-paper hover:text-ink",
                )}
              >
                {navLabel(item, t)}
              </Link>
            );
          })}
        </nav>

        <div className="ms-auto flex items-center gap-1.5">
          {/* Search — a real pill with its own placeholder text on desktop,
              not just a bare icon, so it reads as "search this site" rather
              than a mystery button you have to click to find out. */}
          <Popover
            label={t("searchPh")}
            align="end"
            width="w-96"
            trigger={
              <>
                <span
                  className={cn(
                    "hidden items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-sm font-medium transition md:inline-flex",
                    onImage ? "bg-stage-fg/10 text-stage-fg/70 hover:bg-stage-fg/15" : "bg-paper text-muted hover:bg-brume",
                  )}
                >
                  <Search className="size-4 shrink-0" aria-hidden />
                  {t("searchPh")}
                </span>
                <span
                  className={cn(
                    "inline-flex size-10 items-center justify-center rounded-full transition md:hidden",
                    onImage ? "bg-stage-fg/15 hover:bg-stage-fg/25" : "bg-paper hover:bg-brume",
                  )}
                >
                  <Search className="size-4" aria-hidden />
                </span>
              </>
            }
          >
            {({ close }) => (
              <div className="p-3">
                <Input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && submitSearch(close)}
                  placeholder={t("searchPh")}
                  aria-label={t("searchPh")}
                  className="text-sm"
                />
                {/* Poster thumbnail + month stamp + price, same information
                    hierarchy EventCard uses -- a bare text row told you a
                    title and a city and nothing else, which made the one
                    interactive search result in the whole header feel like
                    an afterthought next to every other event listing. */}
                {results.length > 0 ? (
                  <ul className="mt-2 grid gap-0.5">
                    {results.map((event) => {
                      const stamp = monthBadge(event.start, locale);
                      return (
                        <li key={event.slug}>
                          <Link
                            to={`/evenements/${event.slug}`}
                            onClick={close}
                            className="flex items-center gap-3 rounded-control p-2 transition hover:bg-paper"
                          >
                            <span className="relative shrink-0 overflow-hidden rounded-control">
                              <img src={event.image} alt="" className="size-12 object-cover" />
                              <span className="absolute inset-x-0 bottom-0 bg-stage/70 px-1 py-0.5 text-center font-mono text-[9px] font-bold uppercase leading-none text-stage-fg">
                                {stamp.month} {stamp.day}
                              </span>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold">
                                {eventText(event, "title", locale)}
                              </span>
                              <span className="block truncate text-xs text-muted">{event.city}</span>
                            </span>
                            <span className="shrink-0 text-end">
                              <span className="block text-[10px] font-semibold uppercase text-muted">{t("from")}</span>
                              <span className="block text-sm font-bold tabular-nums">{money(minPriceCents(event))}</span>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            )}
          </Popover>

          {/* Cart — only once there is something in it.
              NOT gated on being logged in: guest checkout is deliberate here
              (Order.customerId is nullable, "null = guest checkout" in
              schema.prisma, and the checkout routes use optionalAuth), so
              hiding this from signed-out visitors would strand a guest who
              picked tickets and leave them no way to pay. An empty cart has
              nothing to show either way, logged in or not. */}
          {cartCount > 0 ? (
            <Link
              to="/paiement"
              aria-label={`${t("cart")} (${cartCount})`}
              className={cn(
                "relative inline-flex size-10 items-center justify-center rounded-full transition",
                onImage ? "bg-stage-fg/15 hover:bg-stage-fg/25" : "bg-paper hover:bg-brume",
              )}
            >
              <Ticket className="size-4" aria-hidden />
              <span className="absolute -end-0.5 -top-0.5 inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-extrabold text-accent-fg tabular-nums">
                {cartCount}
              </span>
            </Link>
          ) : null}

          {/* The header's one deliberate brand-pink moment — everywhere else
              a CTA is the neutral action pill, but this is the single button
              that should pull the eye on every page, so it keeps the brand
              fill instead of blending into the rest of the bar. */}
          <Button variant="brand" size="sm" className="hidden sm:inline-flex" onClick={() => navigate(canUsePro ? "/organiser" : "/devenir-organisateur")}>
            {t("create")}
          </Button>

          {/* Account — holds the session settings that used to crowd the bar.
              The avatar got a ring and a bit more size so it reads as the
              anchor for "your account" rather than a plain coloured circle,
              and the identity card inside gets a matching large avatar
              plus a role badge instead of two lines of bare text. */}
          {!loading && user ? (
            <Popover
              label={t("account")}
              align="end"
              width="w-64"
              trigger={({ open }) => (
                <span className={cn("flex items-center gap-1.5 rounded-full p-0.5 transition", onImage ? "hover:bg-stage-fg/10" : "hover:bg-paper")}>
                  <span
                    className={cn(
                      "inline-flex size-9 items-center justify-center rounded-full bg-primary font-display text-sm font-extrabold text-primary-fg ring-2",
                      onImage ? "ring-stage-fg/25" : "ring-card",
                    )}
                    aria-hidden
                  >
                    {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <ChevronDown className={cn("size-4 transition", open && "rotate-180")} aria-hidden />
                </span>
              )}
            >
              {({ close }) => (
                <>
                  <div className="flex items-center gap-3 border-b border-line/10 px-4 py-4">
                    <span
                      className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-primary font-display text-base font-extrabold text-primary-fg"
                      aria-hidden
                    >
                      {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold">{user.name}</p>
                      <p className="truncate text-xs text-muted">{user.email}</p>
                    </div>
                  </div>
                  <div className="py-1.5">
                    <PopoverItem as={Link} to="/billets" onClick={close}>
                      <Ticket className="size-4 shrink-0 text-muted" aria-hidden />
                      {t("account")}
                    </PopoverItem>
                    {/* Resale lives here because it has nowhere else to go:
                        it was taken out of the top bar for width, and that
                        bar is lg-only anyway, so on a tablet this menu is
                        the only way in.

                        Hidden from staff, for the same reason Pro is hidden
                        from customers below: every seat on that page leads
                        to /resale/:token/buy, which refuseStaffPurchase
                        rejects outright. An organiser following this link
                        would browse a marketplace where every button 403s --
                        a door with no handle behind it.

                        "Create an event" is deliberately NOT repeated here.
                        It is the pink button two inches to the left, and two
                        controls for one action that close together is noise
                        rather than convenience. Below sm, where that button
                        is hidden, the mobile drawer carries it instead. */}
                    {canUsePro ? null : (
                      <PopoverItem as={Link} to="/reventes" onClick={close}>
                        <Tag className="size-4 shrink-0 text-muted" aria-hidden />
                        {t("navResales")}
                      </PopoverItem>
                    )}
                    {/* Pro moved here from the top nav, which had no room
                        left for it once the header got trimmed to 3 items
                        to stop "Culture & Théâtre" / "Espace Pro" wrapping
                        onto a second line.

                        Only for staff: a CUSTOMER who clicked this was
                        bounced straight back to / by Protected, with no
                        explanation — a door with no handle behind it. */}
                    {canUsePro ? (
                      <PopoverItem as={Link} to="/pro" onClick={close}>
                        <LayoutDashboard className="size-4 shrink-0 text-muted" aria-hidden />
                        {t("pro")}
                      </PopoverItem>
                    ) : null}
                    <PopoverItem onClick={toggle}>
                      {resolved === "dark" ? (
                        <Sun className="size-4 shrink-0 text-muted" aria-hidden />
                      ) : (
                        <Moon className="size-4 shrink-0 text-muted" aria-hidden />
                      )}
                      {resolved === "dark" ? t("themeLight") : t("themeDark")}
                    </PopoverItem>
                  </div>
                  <LocaleRow locale={locale} setLocale={setLocale} t={t} />
                  <div className="border-t border-line/10">
                    <PopoverItem
                      className="text-danger hover:bg-danger-bg"
                      onClick={() => {
                        close();
                        logout();
                        navigate("/");
                      }}
                    >
                      <LogOut className="size-4 shrink-0 rtl:rotate-180" aria-hidden />
                      {t("signOut")}
                    </PopoverItem>
                  </div>
                </>
              )}
            </Popover>
          ) : (
            <>
              {/* Signed out: the settings still need a home. */}
              <Popover
                label={t("themeDark")}
                align="end"
                width="w-52"
                className="hidden sm:block"
                trigger={
                  <span
                    className={cn(
                      "inline-flex size-10 items-center justify-center rounded-full transition",
                      onImage ? "bg-stage-fg/15 hover:bg-stage-fg/25" : "bg-paper hover:bg-brume",
                    )}
                  >
                    {resolved === "dark" ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
                  </span>
                }
              >
                <>
                  <div className="py-1.5">
                    <PopoverItem onClick={toggle}>
                      {resolved === "dark" ? (
                        <Sun className="size-4 shrink-0 text-muted" aria-hidden />
                      ) : (
                        <Moon className="size-4 shrink-0 text-muted" aria-hidden />
                      )}
                      {resolved === "dark" ? t("themeLight") : t("themeDark")}
                    </PopoverItem>
                  </div>
                  <LocaleRow locale={locale} setLocale={setLocale} t={t} />
                </>
              </Popover>

              <Button size="sm" onClick={() => navigate("/login")} icon={<User className="size-4 sm:hidden" />}>
                <span className="hidden sm:inline">{t("signIn")}</span>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Mobile sheet — portaled to document.body, not rendered inside
          <header>. The header carries backdrop-blur unconditionally (see
          below), and backdrop-filter establishes a containing block for
          position: fixed descendants exactly like transform does — so a
          fixed drawer nested inside it was never actually pinned to the
          viewport, only to the header's own (much shorter) box. On a
          phone the drawer rendered at roughly its own content height
          instead of the full screen, and everything below that — Sign in,
          the avatar — showed the hero underneath instead of the drawer's
          own background. createPortal is the same fix Modal.jsx already
          uses for the identical reason. */}
      {menuOpen ? createPortal(
        <>
          <div className="fixed inset-0 z-[55] bg-stage/50 backdrop-blur-[2px] lg:hidden" onClick={() => setMenuOpen(false)} role="presentation" />
          <div
            className="fixed inset-y-0 start-0 z-[60] flex w-[min(20rem,86vw)] flex-col bg-card text-ink lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label={t("openMenu")}
          >
            <div className="flex h-16 shrink-0 items-center justify-between border-b border-line/10 px-4">
              <span className="font-display text-lg font-extrabold">
                Eventick<span className="text-primary">.ma</span>
              </span>
              <IconButton label={t("close")} size="sm" onClick={() => setMenuOpen(false)}>
                <X className="size-5" />
              </IconButton>
            </div>

            <nav aria-label={t("explore")} className="min-h-0 flex-1 overflow-y-auto p-3">
              <ul className="grid gap-0.5">
                {NAV.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-control px-3 py-3 text-[15px] font-semibold transition hover:bg-paper"
                    >
                      {navLabel(item, t)}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link
                    to="/billets"
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-control px-3 py-3 text-[15px] font-semibold transition hover:bg-paper"
                  >
                    {t("account")}
                  </Link>
                </li>
                {/* Staff only — same reasoning as the account popover's copy
                    of this link above. */}
                {canUsePro ? (
                  <li>
                    <Link
                      to="/pro"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-control px-3 py-3 text-[15px] font-semibold transition hover:bg-paper"
                    >
                      {t("pro")}
                    </Link>
                  </li>
                ) : null}
                {/* Resale, named explicitly rather than through NAV: it was
                    taken out of the top bar for width, and the drawer maps
                    NAV -- so removing it there silently took it off phones
                    too, where there is no popover to fall back on.

                    Hidden from staff, like its copy in the account menu:
                    buying a resold seat is refused server-side for an
                    ORGANISER or ADMIN. */}
                {canUsePro ? null : (
                  <li>
                    <Link
                      to="/reventes"
                      onClick={() => setMenuOpen(false)}
                      className="block rounded-control px-3 py-3 text-[15px] font-semibold transition hover:bg-paper"
                    >
                      {t("navResales")}
                    </Link>
                  </li>
                )}
                {/* "Create an event" lives in the top bar as a pink button,
                    but that button is `hidden sm:inline-flex` -- so below
                    640px it vanished and was in no menu either. On a phone
                    the one action the header exists to push was unreachable. */}
                <li>
                  <Link
                    to={canUsePro ? "/organiser" : "/devenir-organisateur"}
                    onClick={() => setMenuOpen(false)}
                    className="block rounded-control px-3 py-3 text-[15px] font-semibold text-primary transition hover:bg-paper"
                  >
                    {t("create")}
                  </Link>
                </li>
              </ul>

              <p className="mt-5 px-3 pb-2 text-[11px] font-extrabold uppercase tracking-wide text-muted">{t("allMorocco")}</p>
              <div className="flex flex-wrap gap-2 px-1">
                <button
                  type="button"
                  onClick={() => goCity("")}
                  className="rounded-full bg-paper px-3 py-2 text-sm font-semibold transition hover:bg-brume"
                >
                  {t("allMorocco")}
                </button>
                {CITIES.map((city) => (
                  <button
                    key={city}
                    type="button"
                    onClick={() => goCity(city)}
                    className="rounded-full bg-paper px-3 py-2 text-sm font-semibold transition hover:bg-brume"
                  >
                    {city}
                  </button>
                ))}
              </div>
            </nav>

            <div className="shrink-0 border-t border-line/10 p-3">
              <div className="flex items-center gap-2">
                <IconButton label={resolved === "dark" ? t("themeLight") : t("themeDark")} onClick={toggle}>
                  {resolved === "dark" ? <Sun className="size-5" /> : <Moon className="size-5" />}
                </IconButton>
                <div className="flex flex-1 gap-1.5" role="group" aria-label="locale">
                  {LOCALES.map((code) => (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setLocale(code)}
                      aria-pressed={locale === code}
                      className={cn(
                        "h-10 flex-1 rounded-control text-xs font-extrabold transition",
                        locale === code ? "bg-action text-action-fg" : "bg-paper text-muted",
                      )}
                    >
                      {t(LOCALE_LABELS[code])}
                    </button>
                  ))}
                </div>
              </div>
              {!loading && user ? (
                <Button
                  variant="secondary"
                  full
                  className="mt-3"
                  icon={<LogOut className="size-4 rtl:rotate-180" />}
                  onClick={() => {
                    setMenuOpen(false);
                    logout();
                    navigate("/");
                  }}
                >
                  {t("signOut")}
                </Button>
              ) : (
                <Button
                  full
                  className="mt-3"
                  onClick={() => {
                    setMenuOpen(false);
                    navigate("/login");
                  }}
                >
                  {t("signIn")}
                </Button>
              )}
            </div>
          </div>
        </>
      , document.body) : null}
    </header>
  );
}

function LocaleRow({ locale, setLocale, t }) {
  return (
    <div className="border-t border-line/10 px-4 py-3">
      <div className="flex gap-1.5" role="group" aria-label="locale">
        {LOCALES.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setLocale(code)}
            aria-pressed={locale === code}
            className={cn(
              "h-9 flex-1 rounded-control text-xs font-extrabold transition",
              locale === code ? "bg-action text-action-fg" : "bg-paper text-muted hover:text-ink",
            )}
          >
            {t(LOCALE_LABELS[code])}
          </button>
        ))}
      </div>
    </div>
  );
}
