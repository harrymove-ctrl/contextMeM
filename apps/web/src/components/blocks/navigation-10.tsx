import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDownRight, Boxes, Database, Github, Menu, Server, Twitter, X } from "lucide-react";

type Navigation10Props = {
  statusLabel: string;
  statusTone: "ready" | "needsMemWal" | "preview";
  sessionSlot?: ReactNode;
  authHint?: string;
  onOpenConsole: () => void;
  onInspectArtifacts: () => void;
  onOpenHistory: () => void;
};

export default function Navigation10({
  statusLabel,
  statusTone,
  sessionSlot,
  authHint,
  onOpenConsole,
  onInspectArtifacts,
  onOpenHistory
}: Navigation10Props) {
  const [open, setOpen] = useState(false);

  const runAction = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <header className="rbNav10">
      <motion.nav initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }} className="rbNav10Bar">
        <button className="rbNav10Brand" type="button" onClick={onOpenConsole}>
          <span className="rbNav10Mark">
            <Server size={15} strokeWidth={2.2} />
          </span>
          <span>
            <strong>ContextMeM</strong>
            <small>Walrus Sites context engine</small>
          </span>
        </button>

        <button className="rbNav10Live" type="button" onClick={onOpenConsole}>
          <span className="rbNav10LiveLabel">
            <span className="rbNav10LiveDot" />
            Open ContextMeM
          </span>
          <span className="rbNav10LiveArrow">
            <ArrowDownRight size={14} />
          </span>
        </button>

        <div className="rbNav10Actions">
          <span className={`rbNav10Status ${statusTone}`}>{statusLabel}</span>
          {sessionSlot ? sessionSlot : null}
        </div>
      </motion.nav>

      {authHint ? <div className="rbNav10Hint">{authHint}</div> : null}

      <AnimatePresence>
        {open ? (
          <motion.div
            key="overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={() => setOpen(false)}
            className="rbNav10Overlay"
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <motion.aside
            key="panel"
            initial={{ clipPath: "circle(0% at calc(100% - 18px) 18px)" }}
            animate={{ clipPath: "circle(150% at calc(100% - 18px) 18px)" }}
            exit={{ clipPath: "circle(0% at calc(100% - 18px) 18px)" }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
            className="rbNav10Panel"
          >
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.25, delay: 0.2 }}
              className="rbNav10PanelInner"
            >
              <nav className="rbNav10MenuLinks">
                <button type="button" onClick={() => runAction(onOpenConsole)}>
                  App
                </button>
                <button type="button" onClick={() => runAction(onInspectArtifacts)}>
                  Artifacts
                </button>
                <button type="button" onClick={() => runAction(onOpenHistory)}>
                  History
                </button>
              </nav>

              <div className="rbNav10MenuSection">
                <p>RESOURCES</p>
                <button type="button" onClick={() => runAction(onInspectArtifacts)}>
                  <Boxes size={16} />
                  Inspect context package
                </button>
                <button type="button" onClick={() => runAction(onOpenHistory)}>
                  <Database size={16} />
                  Walrus update history
                </button>
              </div>

              <div className="rbNav10Socials">
                <a href="https://x.com/harry_phan06" target="_blank" rel="noreferrer" aria-label="Harry Phan on X">
                  <Twitter size={16} />
                </a>
                <a href="https://github.com/MystenLabs/walrus-sites" target="_blank" rel="noreferrer" aria-label="Walrus Sites on GitHub">
                  <Github size={16} />
                </a>
              </div>

              <button className="rbNav10PanelCta" type="button" onClick={() => runAction(onOpenConsole)}>
                OPEN APP
                <ArrowDownRight size={17} />
              </button>
            </motion.div>
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <div className="rbNav10ToggleWrap">
        <motion.div
          initial={false}
          animate={{ opacity: open ? 0 : 1 }}
          transition={{ duration: open ? 0 : 0.2, delay: open ? 0 : 0.35 }}
          className="rbNav10ToggleBg"
        />
        <motion.button
          type="button"
          onClick={() => setOpen((value) => !value)}
          initial={false}
          animate={{ x: open ? -1 : 0 }}
          transition={{ duration: 0.25 }}
          className="rbNav10Toggle"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          <span>
            <AnimatePresence mode="wait" initial={false}>
              {open ? (
                <motion.span key="x" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                  <X size={17} />
                </motion.span>
              ) : (
                <motion.span key="m" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                  <Menu size={17} />
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </motion.button>
      </div>
    </header>
  );
}
