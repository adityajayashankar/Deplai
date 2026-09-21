const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual component effect with a controllable viewport and clock.
function setup(width, height) {
    const listeners = new Map();
    const events = (prefix) => ({
        addEventListener: (name, fn) => listeners.set(`${prefix}:${name}`, fn),
        removeEventListener: (name) => listeners.delete(`${prefix}:${name}`),
    });
    const viewport = { width, height, offsetLeft: 0, offsetTop: 0, ...events('viewport') };
    const root = { clientWidth: width, clientHeight: height, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const crab = { offsetWidth: 42, offsetHeight: 38, style: {}, dataset: {} };
    const refs = [root, crab];
    let effect;
    let nextFrame;
    let now = 0;
    const exports = {};
    const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, 'HermitCrab.jsx'), 'utf8'), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(source, {
        exports,
        require: (name) => name === 'react' ? {
            useRef: () => ({ current: refs.shift() }), useEffect: (fn) => { effect = fn; },
        } : { jsx: () => null, jsxs: () => null },
        window: { innerWidth: width, innerHeight: height, visualViewport: viewport,
            matchMedia: () => ({ matches: false, ...events('motion') }), ...events('window') },
        document: { hidden: false, documentElement: { clientWidth: width }, ...events('document') },
        performance: { now: () => now },
        requestAnimationFrame: (fn) => { nextFrame = fn; return 1; },
        cancelAnimationFrame: () => { nextFrame = null; },
    });
    exports.default();
    const cleanup = effect();
    const check = () => {
        const x = parseFloat(crab.style.left);
        const y = parseFloat(crab.style.top);
        assert.ok(x >= viewport.offsetLeft && x + crab.offsetWidth <= viewport.offsetLeft + viewport.width, `x=${x}`);
        assert.ok(y >= viewport.offsetTop && y + crab.offsetHeight <= viewport.offsetTop + viewport.height, `y=${y}`);
        assert.notEqual(crab.style.opacity, '0');
    };
    return { viewport, crab, cleanup, check, listeners,
        run(count) { for (let i = 0; i < count; i++) { now += 16; nextFrame(now); check(); } },
        scare() { listeners.get('window:pointermove')({ pointerType: 'mouse', clientX: parseFloat(crab.style.left), clientY: parseFloat(crab.style.top) }); },
    };
}

test('crab stays visible inside desktop and narrow screens during repeated escapes', () => {
    for (const [width, height] of [[1440, 900], [320, 568]]) {
        const h = setup(width, height);
        h.check();
        for (let i = 0; i < 12; i++) { h.scare(); h.run(240); }
        h.cleanup();
        assert.equal(h.listeners.size, 0);
    }
});

test('resize and panned visual viewport constrain an escape immediately', () => {
    const h = setup(1440, 900);
    h.scare();
    h.run(20);
    Object.assign(h.viewport, { width: 280, height: 300, offsetLeft: 110, offsetTop: 80 });
    h.listeners.get('viewport:resize')();
    h.check();
    h.run(300);
    h.viewport.offsetTop = 180;
    h.listeners.get('viewport:scroll')();
    h.check();
    h.run(300);
    h.cleanup();
});
