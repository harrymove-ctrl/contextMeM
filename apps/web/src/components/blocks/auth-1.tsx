import { useId, useState, type FormEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowLeft, Database, Eye, EyeOff, ExternalLink, KeyRound, LockKeyhole, Server, ShieldCheck, Sparkles } from "lucide-react";

type Auth1Props = {
  authenticated: boolean;
  authBusy: boolean;
  delegateAccountId: string;
  delegateKey: string;
  setDelegateAccountId: (value: string) => void;
  setDelegateKey: (value: string) => void;
  onImport: () => void;
  dashboardUrl: string;
  noticeSlot?: ReactNode;
  variant?: "compact" | "panel";
  onBack?: () => void;
  description?: string;
};

const proofCards = [
  {
    icon: ShieldCheck,
    title: "Encrypted delegate",
    text: "The private key is sent once to the ContextMeM API and reused server-side."
  },
  {
    icon: Database,
    title: "MemWal recall",
    text: "Unlock verified context recall, memory sync, and namespace history."
  },
  {
    icon: Sparkles,
    title: "Full console",
    text: "After import, all Walrus Site tabs, artifacts, and build actions become active."
  },
  {
    icon: Server,
    title: "Mainnet only",
    text: "Built for current mainnet Walrus Sites resources and object IDs."
  }
];

export function Auth1({
  authenticated,
  authBusy,
  delegateAccountId,
  delegateKey,
  setDelegateAccountId,
  setDelegateKey,
  onImport,
  dashboardUrl,
  noticeSlot,
  variant = "panel",
  onBack,
  description
}: Auth1Props) {
  const [showKey, setShowKey] = useState(false);
  const id = useId();
  const accountInputId = `${id}-memwal-account`;
  const keyInputId = `${id}-delegate-key`;
  const canImport = delegateAccountId.trim().length > 0 && delegateKey.trim().length > 0;
  const compact = variant === "compact";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canImport || authBusy) return;
    onImport();
  }

  return (
    <section className={`rbAuth1 ${variant}`}>
      <div className="rbAuth1FormCol">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.42 }} className="rbAuth1Stack">
          <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.32, delay: 0.08 }} className="rbAuth1Logo" aria-hidden="true">
            <LockKeyhole size={compact ? 17 : 20} />
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.34, delay: 0.14 }} className="rbAuth1Copy">
            <span>{authenticated ? "Delegate key required" : "SDK credentials required"}</span>
            <h2>{compact ? "Import SDK credentials" : "Import MemWal SDK credentials"}</h2>
            <p>
              {description ?? "Paste your MemWal account ID and delegate private key. ContextMeM stores the delegate encrypted and unlocks verified Walrus context."}
            </p>
          </motion.div>

          <motion.form initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.34, delay: 0.2 }} className="rbAuth1Form" onSubmit={handleSubmit}>
            <label htmlFor={accountInputId}>MemWal account ID</label>
            <input
              id={accountInputId}
              name="memwalAccountId"
              value={delegateAccountId}
              onChange={(event) => setDelegateAccountId(event.target.value)}
              placeholder="0x..."
              disabled={authBusy}
              autoComplete="username"
              spellCheck={false}
            />

            <label htmlFor={keyInputId}>Delegate private key</label>
            <div className="rbAuth1SecretField">
              <input
                id={keyInputId}
                name="delegatePrivateKey"
                value={delegateKey}
                onChange={(event) => setDelegateKey(event.target.value)}
                placeholder="Paste delegate private key"
                type={showKey ? "text" : "password"}
                disabled={authBusy}
                autoComplete="current-password"
                spellCheck={false}
              />
              <button type="button" onClick={() => setShowKey((value) => !value)} disabled={authBusy} aria-label={showKey ? "Hide delegate private key" : "Show delegate private key"}>
                {showKey ? <Eye size={18} /> : <EyeOff size={18} />}
              </button>
            </div>

            {noticeSlot}

            <button className="rbAuth1Submit" type="submit" disabled={authBusy || !canImport}>
              <KeyRound size={16} />
              {authBusy ? "Importing" : authenticated ? "Import delegate key" : "Import and start session"}
            </button>
          </motion.form>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.34, delay: 0.26 }} className="rbAuth1Footer">
            {onBack ? (
              <button type="button" onClick={onBack}>
                <ArrowLeft size={15} />
                Back to console
              </button>
            ) : null}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Open MemWal dashboard
            </a>
          </motion.div>
        </motion.div>
      </div>

      {compact ? null : (
        <div className="rbAuth1VisualCol" aria-hidden="true">
          <div className="rbAuth1Flicker" />
          <div className="rbAuth1Fade left" />
          <div className="rbAuth1Fade right" />
          <div className="rbAuth1Marquee">
            <div className="rbAuth1MarqueeTrack">
              {[...proofCards, ...proofCards].map((card, index) => {
                const Icon = card.icon;
                return (
                  <article className="rbAuth1ProofCard" key={`${card.title}-${index}`}>
                    <Icon size={20} />
                    <strong>{card.title}</strong>
                    <p>{card.text}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default Auth1;
