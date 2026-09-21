import { useState } from "react";
import { scrollToScene } from "./ui";

export default function HeroConsole() {
    const [val, setVal] = useState("");
    const [hint, setHint] = useState(null);

    const run = (e) => {
        e.preventDefault();
        const cmd = val.trim().toLowerCase();
        if (/^(deplai\s+)?deploy$/.test(cmd) || cmd === "ship it") {
            setHint({ text: "deploy accepted — course locked to production ↓", ok: true });
            setVal("");
            scrollToScene("destination");
        } else if (cmd) {
            setHint({ text: 'unknown command — try "deploy"', ok: false });
        }
    };

    return (
        <div className="dl-console-wrap">
            <form className="dl-term dl-port-term" onSubmit={run} data-testid="hero-console">
                <span className="p">$</span>
                <input
                    value={val}
                    onChange={(e) => setVal(e.target.value)}
                    placeholder="git push deplai main"
                    spellCheck="false"
                    autoComplete="off"
                    aria-label='Terminal — type "deploy" and press Enter'
                    data-testid="hero-console-input"
                />
                {!val && <span className="dl-cursor" aria-hidden="true" />}
            </form>
            <div className={`dl-console-hint ${hint ? `show ${hint.ok ? "ok" : ""}` : ""}`} data-testid="hero-console-hint">
                {hint ? `▸ ${hint.text}` : 'tip — type "deploy" + enter'}
            </div>
        </div>
    );
}
