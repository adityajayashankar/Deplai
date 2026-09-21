/* A broken pixel liner resting on the footer seabed. */
export default function FooterWreck() {
    return (
        <div className="dl-footer-wreck" aria-hidden="true">
            <svg viewBox="0 0 360 110" shapeRendering="crispEdges" fill="none">
                <g opacity=".85">
                    <path d="M20 63h145v8h-7v9h-7v12H40v-6H32v-8H26v-8h-6z" fill="#263d49" />
                    <path d="M32 80h122v7h-8v8H43v-6H32z" fill="#704e47" />
                    <path d="M35 48h117v15H35zM52 37h91v11H52z" fill="#899b92" />
                    {[65, 105].map((x) => <g key={x}><path d={`M${x} 18h13v19h-13z`} fill="#9a7654" /><path d={`M${x} 15h13v6h-13z`} fill="#30434a" /></g>)}
                    <path d="M187 72h148v7h-8v7h-10v8H193v-8h-6z" fill="#263d49" />
                    <path d="M192 86h126v7h-13v5H200v-5h-8z" fill="#704e47" />
                    <path d="M197 57h119v15H197zM204 47h85v10h-85z" fill="#899b92" />
                    {[216, 253].map((x) => <g key={x}><path d={`M${x} 29h13v18h-13z`} fill="#9a7654" /><path d={`M${x} 26h13v6h-13z`} fill="#30434a" /></g>)}
                    {[45, 57, 69, 81, 93, 105, 117, 129, 141, 205, 217, 229, 241, 253, 265, 277, 289, 301].map((x) => <rect key={x} x={x} y={x < 160 ? 54 : 63} width="4" height="4" fill="#c4b88a" />)}
                    <path d="M160 72h7v8h8v7h-8v9h-8v-6h-9M185 78h-7v12h-5v9h20" fill="#182f3a" />
                    <path d="M48 23h3v25h-3zm253 15h3v19h-3z" fill="#617b7d" />
                </g>
                <path d="M0 99h33v-5h50v4h60v-4h29v6h36v-3h75v-4h40v4h37v13H0z" fill="#162b34" />
                <path d="M55 96v-12h-4v-9h4v-7h4v13h4v7h-4v8zm226 2V85h4V73h4v17h-4v8z" fill="#35625a" />
                <g className="dl-wreck-bubbles" fill="#86bdc3" opacity=".45"><rect x="169" y="66" width="3" height="3" /><rect x="176" y="49" width="2" height="2" /><rect x="172" y="28" width="3" height="3" /></g>
            </svg>
        </div>
    );
}
