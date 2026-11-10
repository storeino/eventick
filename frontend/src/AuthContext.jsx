"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const hydrate = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const { user: me } = await api.get("/auth/me");
      setUser(me);
    } catch (err) {
      if (err.status === 401 || err.status === 403) setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const login = useCallback(async (email, password) => {
    const { token, user: me } = await api.post("/auth/login", { email, password });
    setToken(token);
    setUser(me);
    return me;
  }, []);

  const register = useCallback(async (name, email, password, phone) => {
    const { token, user: me } = await api.post("/auth/register", { name, email, password, phone });
    setToken(token);
    setUser(me);
    return me;
  }, []);

  /*
   * Adopt a session the server has already issued.
   *
   * The password reset ends with a token and a user, exactly as login does,
   * but there is nothing to post: the credential was the emailed link and
   * it has just been spent. Without this the reset would have to send them
   * to the login page to type the password they chose ten seconds ago.
   */
  const adoptSession = useCallback((token, me) => {
    setToken(token);
    setUser(me);
    return me;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const { user: me } = await api.get("/auth/me");
    setUser(me);
    return me;
  }, []);

  // All derived from `user` — nowhere for these to drift from it, so plain
  // values computed each render beat memoising.
  //
  // `can(permission)` is the seam every call site should use: it reads the
  // permission list the server sends on /auth/me, so when a role's powers
  // change in the database no frontend code has to change with it.
  const permissions = user?.permissions ?? [];
  const can = useCallback(
    (permission) => permissions.includes(permission),
    // permissions is a fresh array each render; keying on the user identity
    // and the joined list avoids re-creating `can` when nothing changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.id, permissions.join(",")],
  );

  // Derived from capability, not role. If an admin revokes events.manage
  // from ORGANISER, the dashboard link has to disappear with it — gating
  // this on the role name instead would leave the link visible pointing at
  // a screen that now 403s on every call it makes.
  const canUsePro = permissions.includes("events.manage");

  // No `isAdmin` here on purpose. Every UI question that looked like "is
  // this person an admin" turned out to be a capability question with a
  // different answer: the pro area is events.manage, the admin section is
  // users.manage, and the cross-organiser filters are scope.any. Exposing a
  // role flag alongside those just invites the next guard to reach for the
  // role name and drift from what the server actually enforces. Anything
  // that genuinely needs the role itself can read `user.role`.
  const canManageUsers = permissions.includes("users.manage");

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, adoptSession, logout, refresh, canUsePro, canManageUsers, can, permissions }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
