// Dev-only fixtures: the quick-login buttons under the login form, and the
// sample bank details on Finance. Both are rendered only when
// NODE_ENV !== "production", so none of this reaches a real deployment.
//
// Must stay in sync with backend/prisma/seed.ts — these rows only exist
// after `npx prisma db seed` has run.
export const DEMO_ACCOUNTS = [
  {
    id: "client",
    email: "client@eventick.ma",
    password: "client123",
    labelFr: "Client",
    labelAr: "زبون",
    roleFr: "Achat de billets",
    roleAr: "شراء التذاكر",
  },
  {
    id: "organiser",
    email: "organisateur@eventick.ma",
    password: "orga1234",
    labelFr: "Organisateur",
    labelAr: "منظم",
    roleFr: "Espace Pro",
    roleAr: "مساحة المنظم",
  },
  {
    id: "admin",
    email: "admin@eventick.ma",
    password: "admin123",
    labelFr: "Admin",
    labelAr: "مدير",
    roleFr: "Administration",
    roleAr: "الإدارة",
  },
];
