import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type AccountRecord = {
  id: string;
  ownerAddress: string;
  provider: "unknown";
  memwalAccountId?: string;
  delegateKeyCiphertext?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  tokenHash: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
};

export type QuotaState = {
  limit: number;
  used: number;
  remaining: number;
  resetAt?: string;
};

type RunOwnerRecord = {
  runId: string;
  accountId: string;
  createdAt: string;
};

type QuotaConsumptionRecord = {
  id: string;
  accountId: string;
  runId: string;
  consumedAt: string;
};

type AccountState = {
  accounts: AccountRecord[];
  sessions: SessionRecord[];
  runOwners: RunOwnerRecord[];
  quotaConsumptions: QuotaConsumptionRecord[];
};

const emptyState = (): AccountState => ({
  accounts: [],
  sessions: [],
  runOwners: [],
  quotaConsumptions: []
});

export const freeRunLimit = 1;
export const rollingWindowMs = 24 * 60 * 60 * 1000;

export interface AccountStore {
  getAccount(accountId: string): Promise<AccountRecord | undefined>;
  getAccountByOwner(ownerAddress: string): Promise<AccountRecord | undefined>;
  upsertAccount(ownerAddress: string, provider: AccountRecord["provider"]): Promise<AccountRecord>;
  createSession(accountId: string, expiresAt: string): Promise<string>;
  getSession(token: string): Promise<SessionRecord | undefined>;
  deleteSession(token: string): Promise<void>;
  saveDelegate(accountId: string, memwalAccountId: string, delegateKeyCiphertext: string): Promise<AccountRecord>;
  setRunOwner(runId: string, accountId: string): Promise<void>;
  getRunOwner(runId: string): Promise<string | undefined>;
  listOwnedRunIds(accountId: string): Promise<string[]>;
  getQuota(accountId: string): Promise<QuotaState>;
  consumeQuota(accountId: string, runId: string): Promise<QuotaState>;
}

export class LocalAccountStore implements AccountStore {
  private state?: AccountState;

  constructor(private readonly filePath: string) {}

  async getAccount(accountId: string): Promise<AccountRecord | undefined> {
    const state = await this.read();
    return state.accounts.find((account) => account.id === accountId);
  }

  async getAccountByOwner(ownerAddress: string): Promise<AccountRecord | undefined> {
    const state = await this.read();
    return state.accounts.find((account) => account.ownerAddress.toLowerCase() === ownerAddress.toLowerCase());
  }

  async upsertAccount(ownerAddress: string, provider: AccountRecord["provider"]): Promise<AccountRecord> {
    const state = await this.read();
    const now = new Date().toISOString();
    const existing = state.accounts.find((account) => account.ownerAddress.toLowerCase() === ownerAddress.toLowerCase());
    if (existing) {
      existing.provider = provider;
      existing.updatedAt = now;
      await this.write(state);
      return existing;
    }
    const account: AccountRecord = {
      id: `acct_${crypto.randomUUID()}`,
      ownerAddress,
      provider,
      createdAt: now,
      updatedAt: now
    };
    state.accounts.push(account);
    await this.write(state);
    return account;
  }

  async createSession(accountId: string, expiresAt: string): Promise<string> {
    const state = await this.read();
    const token = `ctx_${crypto.randomBytes(32).toString("base64url")}`;
    state.sessions.push({
      tokenHash: hashToken(token),
      accountId,
      createdAt: new Date().toISOString(),
      expiresAt
    });
    await this.write(state);
    return token;
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const state = await this.read();
    const now = Date.now();
    state.sessions = state.sessions.filter((session) => Date.parse(session.expiresAt) > now);
    const session = state.sessions.find((item) => item.tokenHash === hashToken(token));
    await this.write(state);
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    const state = await this.read();
    state.sessions = state.sessions.filter((session) => session.tokenHash !== hashToken(token));
    await this.write(state);
  }

  async saveDelegate(accountId: string, memwalAccountId: string, delegateKeyCiphertext: string): Promise<AccountRecord> {
    const state = await this.read();
    const account = state.accounts.find((item) => item.id === accountId);
    if (!account) throw new Error("Account not found.");
    account.memwalAccountId = memwalAccountId;
    account.delegateKeyCiphertext = delegateKeyCiphertext;
    account.updatedAt = new Date().toISOString();
    await this.write(state);
    return account;
  }

  async setRunOwner(runId: string, accountId: string): Promise<void> {
    const state = await this.read();
    if (!state.runOwners.some((item) => item.runId === runId)) {
      state.runOwners.push({ runId, accountId, createdAt: new Date().toISOString() });
      await this.write(state);
    }
  }

  async getRunOwner(runId: string): Promise<string | undefined> {
    const state = await this.read();
    return state.runOwners.find((item) => item.runId === runId)?.accountId;
  }

  async listOwnedRunIds(accountId: string): Promise<string[]> {
    const state = await this.read();
    return state.runOwners.filter((item) => item.accountId === accountId).map((item) => item.runId);
  }

  async getQuota(accountId: string): Promise<QuotaState> {
    const state = await this.read();
    return quotaFromState(state, accountId);
  }

  async consumeQuota(accountId: string, runId: string): Promise<QuotaState> {
    const state = await this.read();
    if (!state.quotaConsumptions.some((item) => item.runId === runId)) {
      state.quotaConsumptions.push({
        id: crypto.randomUUID(),
        accountId,
        runId,
        consumedAt: new Date().toISOString()
      });
    }
    await this.write(state);
    return quotaFromState(state, accountId);
  }

  private async read(): Promise<AccountState> {
    if (this.state) return this.state;
    try {
      this.state = normalizeState(JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<AccountState>);
    } catch {
      this.state = emptyState();
      await this.write(this.state);
    }
    return this.state;
  }

  private async write(state: AccountState): Promise<void> {
    this.state = state;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export function publicAccount(account: AccountRecord) {
  return {
    id: account.id,
    ownerAddress: account.ownerAddress,
    provider: account.provider,
    memwalAccountId: account.memwalAccountId,
    hasDelegateKey: Boolean(account.delegateKeyCiphertext),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function encryptSecret(secret: string, encryptionSecret: string): string {
  const key = crypto.createHash("sha256").update(encryptionSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptSecret(ciphertext: string, encryptionSecret: string): string {
  const [version, ivRaw, tagRaw, encryptedRaw] = ciphertext.split(":");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) throw new Error("Unsupported encrypted secret format.");
  const key = crypto.createHash("sha256").update(encryptionSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function quotaFromState(state: AccountState, accountId: string): QuotaState {
  const cutoff = Date.now() - rollingWindowMs;
  state.quotaConsumptions = state.quotaConsumptions.filter((item) => Date.parse(item.consumedAt) >= cutoff);
  const items = state.quotaConsumptions.filter((item) => item.accountId === accountId).sort((a, b) => Date.parse(a.consumedAt) - Date.parse(b.consumedAt));
  const used = items.length;
  const resetAt = items[0] ? new Date(Date.parse(items[0].consumedAt) + rollingWindowMs).toISOString() : undefined;
  return {
    limit: freeRunLimit,
    used,
    remaining: Math.max(0, freeRunLimit - used),
    resetAt
  };
}

function normalizeState(raw: Partial<AccountState>): AccountState {
  return {
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
    runOwners: Array.isArray(raw.runOwners) ? raw.runOwners : [],
    quotaConsumptions: Array.isArray(raw.quotaConsumptions) ? raw.quotaConsumptions : []
  };
}
