import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export type StoredUser = {
  id: string;
  displayName: string;
  createdAt: string;
  lastActiveAt: string;
};

export type StoredSession = {
  id: string;
  name: string;
  roomName: string;
  ownerId: string;
  createdAt: string;
  lastActiveAt: string;
};

export type StoredMembership = {
  userId: string;
  sessionId: string;
  role: "master" | "peer";
  joinedAt: string;
  lastActiveAt: string;
};

export type StoredAuthSession = {
  token: string;
  userId: string;
  createdAt: string;
  lastActiveAt: string;
};

export type SessionSummary = StoredSession & {
  role: "master" | "peer";
  memberCount: number;
};

type StoreData = {
  users: StoredUser[];
  sessions: StoredSession[];
  memberships: StoredMembership[];
  authSessions: StoredAuthSession[];
};

const emptyStore = (): StoreData => ({
  users: [],
  sessions: [],
  memberships: [],
  authSessions: []
});

const toIso = (value: Date) => value.toISOString();

export type Store = {
  login: (displayName: string) => { user: StoredUser; token: string };
  getUserByToken: (token: string) => StoredUser | null;
  listSessionsForUser: (userId: string) => SessionSummary[];
  createSession: (userId: string, name: string) => SessionSummary;
  joinSession: (userId: string, sessionId: string, role: "master" | "peer") => SessionSummary | null;
  getSessionById: (sessionId: string) => StoredSession | null;
};

export type StoreOptions = {
  filePath: string;
  now?: () => Date;
  persist?: boolean;
};

export const createStore = ({ filePath, now = () => new Date(), persist = true }: StoreOptions): Store => {
  const resolvedPath = path.resolve(filePath);
  let data: StoreData = emptyStore();

  const load = () => {
    if (!persist) {
      return;
    }
    if (!fs.existsSync(resolvedPath)) {
      const dir = path.dirname(resolvedPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, JSON.stringify(data, null, 2));
      return;
    }
    const raw = fs.readFileSync(resolvedPath, "utf-8");
    data = raw ? (JSON.parse(raw) as StoreData) : emptyStore();
  };

  const save = () => {
    if (!persist) {
      return;
    }
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${resolvedPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, resolvedPath);
  };

  load();

  const touchUser = (user: StoredUser) => {
    user.lastActiveAt = toIso(now());
  };

  const touchSession = (session: StoredSession) => {
    session.lastActiveAt = toIso(now());
  };

  const touchMembership = (membership: StoredMembership) => {
    membership.lastActiveAt = toIso(now());
  };

  const upsertMembership = (
    userId: string,
    sessionId: string,
    role: "master" | "peer"
  ): StoredMembership => {
    const existing = data.memberships.find(
      (membership) => membership.userId === userId && membership.sessionId === sessionId
    );
    if (existing) {
      existing.role = role;
      touchMembership(existing);
      return existing;
    }
    const timestamp = toIso(now());
    const membership: StoredMembership = {
      userId,
      sessionId,
      role,
      joinedAt: timestamp,
      lastActiveAt: timestamp
    };
    data.memberships.push(membership);
    return membership;
  };

  const getSessionSummary = (session: StoredSession, membership: StoredMembership): SessionSummary => {
    const memberCount = data.memberships.filter((entry) => entry.sessionId === session.id).length;
    return {
      ...session,
      role: membership.role,
      memberCount
    };
  };

  return {
    login: (displayName: string) => {
      const trimmed = displayName.trim();
      const existing = data.users.find((user) => user.displayName === trimmed);
      const timestamp = toIso(now());
      const user =
        existing ??
        ({
          id: randomUUID(),
          displayName: trimmed,
          createdAt: timestamp,
          lastActiveAt: timestamp
        } as StoredUser);

      if (!existing) {
        data.users.push(user);
      }

      touchUser(user);
      const token = randomUUID();
      data.authSessions.push({
        token,
        userId: user.id,
        createdAt: timestamp,
        lastActiveAt: timestamp
      });
      save();
      return { user, token };
    },
    getUserByToken: (token: string) => {
      const session = data.authSessions.find((entry) => entry.token === token);
      if (!session) {
        return null;
      }
      const user = data.users.find((entry) => entry.id === session.userId);
      if (!user) {
        return null;
      }
      touchUser(user);
      session.lastActiveAt = toIso(now());
      save();
      return user;
    },
    listSessionsForUser: (userId: string) => {
      const memberships = data.memberships.filter((entry) => entry.userId === userId);
      const sessions = memberships
        .map((membership) => {
          const session = data.sessions.find((entry) => entry.id === membership.sessionId);
          return session ? getSessionSummary(session, membership) : null;
        })
        .filter((value): value is SessionSummary => Boolean(value));
      return sessions.sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
    },
    createSession: (userId: string, name: string) => {
      const trimmed = name.trim();
      const timestamp = toIso(now());
      const id = randomUUID();
      const session: StoredSession = {
        id,
        name: trimmed,
        roomName: id,
        ownerId: userId,
        createdAt: timestamp,
        lastActiveAt: timestamp
      };
      data.sessions.push(session);
      const membership = upsertMembership(userId, session.id, "master");
      touchSession(session);
      touchMembership(membership);
      save();
      return getSessionSummary(session, membership);
    },
    joinSession: (userId: string, sessionId: string, role: "master" | "peer") => {
      const session = data.sessions.find((entry) => entry.id === sessionId);
      if (!session) {
        return null;
      }
      const membership = upsertMembership(userId, sessionId, role);
      touchSession(session);
      touchMembership(membership);
      save();
      return getSessionSummary(session, membership);
    },
    getSessionById: (sessionId: string) => {
      return data.sessions.find((entry) => entry.id === sessionId) ?? null;
    }
  };
};
