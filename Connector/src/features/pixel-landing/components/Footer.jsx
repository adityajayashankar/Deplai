import FooterWreck from "./FooterWreck";

const COLS = [
    {
        h: "Product",
        links: [
            { label: "Agents", href: "#crew" },
            { label: "Security", href: "#security" },
            { label: "Deployments", href: "#destination" },
            { label: "Docs", href: "/dashboard/documentation" },
        ],
    },
    {
        h: "Company",
        links: [
            { label: "Contact", href: "mailto:support@deplai.tech" },
            { label: "Book a demo", href: "mailto:demo@deplai.tech" },
        ],
    },
    {
        h: "Legal",
        links: [
            { label: "Privacy", href: "/privacy" },
            { label: "Terms", href: "/terms" },
        ],
    },
];

const BUBBLES = [
    { left: "12%", size: 5, delay: "0s" },
    { left: "14%", size: 3, delay: "-3s" },
    { left: "47%", size: 4, delay: "-5.5s" },
    { left: "49%", size: 6, delay: "-1.8s" },
    { left: "81%", size: 4, delay: "-7s" },
    { left: "84%", size: 3, delay: "-2.4s" },
];

const Shark = () => (
    <svg className="dl-shark-body" width="210" height="80" viewBox="0 0 210 80" fill="none">
        {/* Nose points left; travel must stay leftward without mirroring. */}
        <g className="dl-shark-tail">
            <path d="M160 36L183 26L202 5L195 34L204 62L181 47L160 44Z" fill="#38596d" stroke="#648899" strokeWidth="1.3" />
            <path d="M180 36L198 13L189 36L198 55L179 44Z" fill="#243e53" />
        </g>
        <path d="M78 25L95 3L99 22L116 30Z" fill="#38596d" stroke="#648899" strokeWidth="1.3" />
        <path
            d="M10 40Q28 25 55 23Q100 17 137 32L171 36V44L139 49Q98 64 54 55Q27 52 10 40Z"
            fill="#41677c" stroke="#648899" strokeWidth="1.4"
        />
        <path d="M13 41Q55 49 98 45L167 41L139 49Q98 64 54 55Q27 52 13 41Z" fill="#8ba8af" opacity=".75" />
        <path d="M51 27Q84 21 114 28" stroke="#a0c2cb" strokeWidth="2" opacity=".4" />
        <path className="dl-shark-fin" d="M76 44L96 72L101 50L114 46Z" fill="#2b485d" stroke="#5a7c8a" strokeWidth="1.2" />
        <path d="M51 33L49 44M58 32L56 46M65 32L63 46M17 44Q27 48 38 45" stroke="#1b3445" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="33" cy="35" r="3" fill="#101f2b" />
        <circle cx="32" cy="34" r="1" fill="#d0e2df" />
    </svg>
);

const Clownfish = () => (
    <svg width="58" height="32" viewBox="0 0 60 32" fill="none">
        {/* tail + body, facing right */}
        <g className="dl-fish-tail"><polygon points="3,16 3,7 17,13 17,19 3,25" fill="#ff8a3d" stroke="#c85f14" strokeWidth="1.2" /><path d="M5 12L14 15M5 20L14 17" stroke="#ffd391" strokeWidth="1" /></g>
        <ellipse cx="33" cy="16" rx="20" ry="11" fill="#ff8a3d" stroke="#c85f14" strokeWidth="1.4" />
        {/* dorsal + belly fins */}
        <path d="M22,6 Q33,-1 45,7 L43,9 Q33,3 24,8 Z" fill="#e06f1c" />
        <path d="M26,26 Q33,31 40,26 L38,24 Q33,27 28,24 Z" fill="#e06f1c" />
        {/* three white bands */}
        <path d="M41,6.5 Q45,16 41,25.5 L46.5,24.5 Q50,16 46.5,7.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="1" />
        <path d="M26,6 Q30,16 26,26 L31.5,25.5 Q35,16 31.5,6.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="1" />
        <path d="M15,9 Q18,16 15,23 L18.5,22.5 Q21,16 18.5,9.5 Z" fill="#f4f0ea" stroke="#2a323d" strokeWidth="0.9" />
        {/* eye */}
        <circle cx="47" cy="13" r="2.6" fill="#f4f0ea" />
        <circle cx="47.6" cy="13.4" r="1.4" fill="#05070a" />
        <path d="M33 17Q39 13 39 21Z" fill="#ffc273" stroke="#c85f14" strokeWidth=".8" />
        <path d="M21 10Q28 5 37 8" stroke="#ffe0a3" strokeWidth="1.3" opacity=".7" />
        <path d="M49 20h3" stroke="#8f441e" strokeWidth="1" />
    </svg>
);

const SmallFish = ({ w = 30 }) => (
    <svg width={w} height={(w * 14) / 30} viewBox="0 0 30 14" fill="none">
        <g className="dl-fish-tail"><polygon points="1,2 10,6 10,8 1,12" fill="#619fae" /></g>
        <path d="M13 3L17 0L21 3" fill="#74b2bb" />
        <ellipse cx="17" cy="7" rx="11" ry="5.5" fill="#4a7ba6" />
        <ellipse cx="17" cy="8.6" rx="9" ry="2.8" fill="#35597c" />
        <path d="M10 5Q17 2 22 5M15 8L19 7L18 10" stroke="#9bcaca" strokeWidth=".9" />
        <circle cx="24" cy="6" r="1.3" fill="#05070a" />
        <circle cx="24.3" cy="5.7" r=".45" fill="#e5f2dd" />
    </svg>
);

const Jellyfish = () => (
    <svg width="42" height="54" viewBox="0 0 42 54" fill="none">
        <path d="M7,22 a14,14 0 0 1 28,0 z" fill="#7b61ff" opacity="0.8" />
        <path d="M7,22 q3,4 7,0 q3,4 7,0 q3,4 7,0 q3,4 7,0" stroke="#8f76ff" strokeWidth="2" fill="none" />
        <g stroke="#7b61ff" strokeWidth="2" strokeLinecap="round" opacity="0.7">
            <path d="M13,26 q-3,10 1,18" />
            <path d="M21,27 q0,10 -2,21" />
            <path d="M29,26 q3,10 0,19" />
        </g>
    </svg>
);

export default function Footer() {
    return (
        <footer className="dl-footer" data-testid="site-footer">
            {/* deep sea layer */}
            <div className="dl-sea" aria-hidden="true">
                <div className="dl-rays" />
                <div className="dl-rays r2" />
                {BUBBLES.map((b, i) => (
                    <i key={i} className="dl-bubble" style={{ left: b.left, width: b.size, height: b.size, animationDelay: b.delay }} />
                ))}
                <div className="dl-shark">
                    <Shark />
                </div>
                <div className="dl-nemo">
                    <Clownfish />
                </div>
                <div className="dl-smlfish f1">
                    <SmallFish />
                </div>
                <div className="dl-smlfish f2">
                    <SmallFish w={22} />
                </div>
                <div className="dl-jelly">
                    <Jellyfish />
                </div>
            </div>

            <div className="dl-footer-inner">
                <div className="dl-footer-brand">
                    <div className="word">
                        DEPL<em>AI</em>
                    </div>
                    <p>The autonomous software shipping company. One voyage: your code to production.</p>
                    <div className="dl-footer-coords">
                        support@deplai.tech
                        <br />
                        Secure delivery · Human reviewed
                    </div>
                </div>
                {COLS.map((c) => (
                    <div className="dl-footer-col" key={c.h}>
                        <h4>{c.h}</h4>
                        {c.links.map((link) => (
                            <a key={link.label} href={link.href} data-testid={`footer-link-${link.label.toLowerCase().replaceAll(" ", "-")}`}>
                                {link.label}
                            </a>
                        ))}
                    </div>
                ))}
            </div>

            {/* sea floor */}
            <div className="dl-seafloor" aria-hidden="true">
                <FooterWreck />
                <svg viewBox="0 0 1600 160" preserveAspectRatio="none" width="100%" height="100%">
                    <g fill="#0a1524">
                        <polygon points="0,160 0,110 90,88 200,112 300,96 380,118 480,104 560,160" />
                        <polygon points="1020,160 1080,104 1180,88 1290,116 1380,98 1480,120 1600,100 1600,160" />
                        <polygon points="560,160 640,126 760,138 860,124 960,142 1040,160" />
                    </g>
                    <g fill="#060d18">
                        <polygon points="0,160 0,134 140,120 260,140 380,128 500,144 620,160" />
                        <polygon points="900,160 1000,132 1120,148 1240,130 1380,146 1600,126 1600,160" />
                    </g>
                    {/* sunken container from an old deploy */}
                    <g transform="translate(690,108) rotate(-7)">
                        <rect width="110" height="40" fill="#8f6600" stroke="#5c4300" strokeWidth="2" />
                        {[18, 34, 50, 66, 82, 96].map((x) => (
                            <line key={x} x1={x} y1="4" x2={x} y2="36" stroke="#5c4300" strokeWidth="1.4" opacity="0.6" />
                        ))}
                        <text x="55" y="24" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="9" fill="#2a1e00" letterSpacing="1">
                            DPL-0007
                        </text>
                    </g>
                    {/* seaweed */}
                    <g stroke="#1d4a44" strokeWidth="5" strokeLinecap="round" fill="none">
                        <path className="dl-weed" d="M150,132 q-8,-22 2,-42 q8,-18 -2,-34" />
                        <path className="dl-weed w2" d="M178,136 q8,-20 -2,-38" />
                        <path className="dl-weed" d="M1330,128 q-8,-24 2,-44 q8,-16 -2,-32" />
                        <path className="dl-weed w2" d="M1360,134 q8,-18 -2,-36" />
                    </g>
                </svg>
            </div>

            <div className="dl-footer-bar">
                <span>© 2026 DeplAI</span>
                <div className="dl-footer-status" data-testid="footer-status">
                    <span>
                        <i />
                        Human review required
                    </span>
                    <span>
                        <i />
                        AWS deploy available
                    </span>
                    <span>
                        <i />
                        Support connected
                    </span>
                </div>
                <span>Secure · Controlled</span>
            </div>
        </footer>
    );
}
