/* The DEPLAI ship — brand protagonist. Side view, bow faces right. */

const Container = ({ x, y, fill, line, label, text, serial }) => (
    <g>
        <rect x={x} y={y} width="112" height="42" fill={fill} stroke={line} strokeWidth="2" />
        {/* corner castings */}
        {[
            [0, 0],
            [104, 0],
            [0, 34],
            [104, 34],
        ].map(([dx, dy]) => (
            <rect key={`${dx}-${dy}`} x={x + dx} y={y + dy} width="8" height="8" fill={line} />
        ))}
        {[24, 38, 52, 66, 80, 94].map((dx) => (
            <line key={dx} x1={x + dx} y1={y + 6} x2={x + dx} y2={y + 36} stroke={line} strokeWidth="1.3" opacity="0.5" />
        ))}
        <text x={x + 56} y={y + 26} textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="12.5" fontWeight="700" fill={text} letterSpacing="1">
            {label}
        </text>
        <text x={x + 14} y={y + 14} fontFamily="IBM Plex Mono, monospace" fontSize="6.5" fill={text} opacity="0.75">
            {serial}
        </text>
    </g>
);

export default function Ship({ className = "", style, small = false }) {
    return (
        <svg className={className} style={style} viewBox="0 0 640 310" fill="none" role="img" aria-label="Deplai cargo ship">
            <style>{`
                .dl-ship-radar { transform-box: fill-box; transform-origin: center; animation: dl-ship-spin 3.6s linear infinite; }
                @keyframes dl-ship-spin { to { transform: rotate(360deg); } }
                .dl-ship-blink { animation: dl-ship-blink 1.8s steps(2) infinite; }
                @keyframes dl-ship-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
                .dl-ship-flicker { animation: dl-ship-flick 4.2s linear infinite; }
                @keyframes dl-ship-flick { 0%,100% { opacity: 1; } 46% { opacity: 1; } 47% { opacity: .3; } 48% { opacity: 1; } }
            `}</style>

            {/* hull — raked bow, two-tone */}
            <polygon points="26,166 524,166 606,122 618,132 590,214 544,250 60,250 26,202" fill="#10233c" stroke="#4a6b82" strokeWidth="3" />
            <polygon points="26,208 590,208 590,214 544,250 60,250 26,202" fill="#081426" />
            <polygon points="26,166 524,166 606,122 611,128 524,174 26,174" fill="#00f0ff" opacity="0.95" />
            <polygon points="30,206 588,206 586,210 34,210" fill="#ffb800" opacity="0.65" />
            <line x1="36" y1="160" x2="520" y2="160" stroke="#3a5570" strokeWidth="2" strokeDasharray="2 10" />

            {/* hull markings */}
            <text x="262" y="228" textAnchor="middle" fontFamily="IBM Plex Mono, monospace" fontSize="27" fontWeight="700" fill="#f4f0ea" letterSpacing="8">
                DEPLAI
            </text>
            <text x="506" y="198" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#8ca0b3" letterSpacing="2">
                DPL-01
            </text>
            {[82, 120, 158, 196].map((x) => (
                <rect key={x} x={x} y="194" width="9" height="9" fill="#f4f0ea" opacity="0.8" />
            ))}
            <circle cx="558" cy="182" r="5" fill="#081426" stroke="#3a5570" strokeWidth="1.5" />

            {/* nav lights + engine */}
            <rect className="dl-ship-blink" x="600" y="122" width="7" height="7" fill="#00ff9d" />
            <rect className="dl-ship-blink" x="27" y="158" width="7" height="7" fill="#ff4a4a" style={{ animationDelay: "-0.9s" }} />
            <rect className="dl-ship-flicker" x="27" y="216" width="7" height="18" fill="#00f0ff" />

            {/* superstructure — raked bridge */}
            <polygon points="34,166 34,80 96,66 130,84 130,166" fill="#f4f0ea" stroke="#c9c2b2" strokeWidth="2" />
            <polygon points="34,80 96,66 130,84 130,94 34,92" fill="#0e1c30" />
            <polygon points="42,102 122,99 122,112 42,115" fill="#00f0ff" opacity="0.92" />
            {[0, 1, 2, 3].map((col) => (
                <rect key={`w1-${col}`} x={44 + col * 20} y="124" width="11" height="11" fill="#00f0ff" opacity="0.9" />
            ))}
            {[0, 1, 2].map((col) => (
                <rect key={`w2-${col}`} x={44 + col * 20} y="144" width="11" height="11" fill="#00f0ff" opacity={col === 2 ? 0.25 : 0.9} />
            ))}
            <rect x="26" y="110" width="10" height="6" fill="#c9c2b2" />
            <rect x="128" y="110" width="10" height="6" fill="#c9c2b2" />

            {/* mast cluster */}
            <rect x="76" y="32" width="4" height="42" fill="#8ca0b3" />
            <g className="dl-ship-radar">
                <rect x="60" y="28" width="36" height="4" fill="#8ca0b3" />
                <rect x="76" y="22" width="4" height="10" fill="#8ca0b3" />
            </g>
            <line x1="96" y1="66" x2="110" y2="40" stroke="#8ca0b3" strokeWidth="2" />
            <circle className="dl-ship-blink" cx="110" cy="38" r="3" fill="#00f0ff" />
            <circle className="dl-ship-blink" cx="78" cy="18" r="4" fill="#ffb800" />
            {!small && <polygon points="82,12 108,18 82,24" fill="#00f0ff" />}

            {/* cargo — the application */}
            <Container x={146} y={124} fill="#4a6b82" line="#2a3a4a" label="DATABASE" text="#e8ecef" serial="DPL-0093" />
            <Container x={146} y={82} fill="#0fa8b8" line="#0a6b78" label="FRONTEND" text="#05070a" serial="DPL-1042" />
            <Container x={264} y={124} fill="#3a5570" line="#24394e" label="API" text="#e8ecef" serial="DPL-2210" />
            <Container x={264} y={82} fill="#d99a00" line="#8f6600" label="WORKERS" text="#05070a" serial="DPL-3187" />
            <Container x={382} y={124} fill="#5a44c8" line="#3d2d8a" label="INFRA" text="#e8ecef" serial="DPL-4410" />

            {/* deck gear + bow foam */}
            <rect x="506" y="150" width="5" height="16" fill="#4a6b82" />
            <rect x="500" y="146" width="34" height="5" fill="#4a6b82" />
            <path className="dl-ship-flicker" d="M596,238 q16,5 30,0 q-9,11 -28,9 z" fill="#9fd8e8" opacity="0.7" />
        </svg>
    );
}
