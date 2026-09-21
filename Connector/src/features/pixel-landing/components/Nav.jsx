import { useState } from "react";
import SoundToggle from "./SoundToggle";

const LINKS = [
    { label: "Pricing", href: "/dashboard/billing", testid: "nav-link-pricing" },
    { label: "Demo", href: "mailto:demo@deplai.tech", testid: "nav-link-demo" },
    { label: "Docs ↗", href: "/dashboard/documentation", testid: "nav-link-docs" },
];

const LogoMark = () => (
    <svg width="30" height="22" viewBox="0 0 30 22" fill="none" aria-hidden="true">
        <polygon points="1,11 22,11 29,7 29,9 26,15 24,17 3,17 1,13" fill="#0e1c30" stroke="#00f0ff" strokeWidth="1.4" />
        <rect x="6" y="7" width="5" height="4" fill="#00f0ff" />
        <rect x="12" y="7" width="5" height="4" fill="#ffb800" />
        <rect x="18" y="7" width="4" height="4" fill="#4a6b82" />
        <rect x="3" y="4" width="3" height="7" fill="#f4f0ea" />
    </svg>
);

export default function Nav({ active }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <header className="dl-nav dl-nav-reference" data-testid="main-nav">
                <nav className="dl-nav-links" aria-label="Primary">
                    {LINKS.map((l) => (
                        <a key={l.label} className="dl-nav-link" href={l.href} data-testid={l.testid}>
                            {l.label}
                        </a>
                    ))}
                </nav>
                <a className="dl-nav-logo" href="#port" data-testid="nav-logo">
                    <LogoMark />
                    <span className="word">
                        DEPL<em>AI</em>
                    </span>
                </a>
                <div className="dl-nav-right">
                    <a className="dl-nav-signin" href="/auth/login" data-testid="nav-signin">
                        Log in
                    </a>
                    <a className="dl-nav-cta" href="mailto:demo@deplai.tech" data-testid="nav-cta-request-demo">
                        Request demo ↗
                    </a>
                    <button
                        className={`dl-nav-burger ${open ? "open" : ""}`}
                        aria-label={open ? "Close menu" : "Open menu"}
                        aria-expanded={open}
                        data-testid="nav-menu-toggle"
                        onClick={() => setOpen((v) => !v)}
                    >
                        <span />
                        <span />
                        <span />
                    </button>
                </div>
            </header>
            {open && (
                <nav className="dl-mobile-menu dl-mobile-reference" aria-label="Mobile" data-testid="mobile-menu">
                    {LINKS.map((l) => (
                        <a key={l.label} href={l.href} data-testid={`mobile-${l.testid}`} onClick={() => setOpen(false)}>
                            {l.label}
                        </a>
                    ))}
                    <a href="/auth/login" data-testid="mobile-nav-signin" onClick={() => setOpen(false)}>
                        Log in
                    </a>
                    <a href="mailto:demo@deplai.tech" data-testid="mobile-nav-cta" onClick={() => setOpen(false)}>
                        Request demo ↗
                    </a>
                </nav>
            )}
            <div className="dl-nav-sound"><SoundToggle active={active} /></div>
        </>
    );
}
