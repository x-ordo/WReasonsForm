window.tailwind = { config: { } };
/* suppress Tailwind Play CDN production warning */
const _tw = console.warn; 
console.warn = (...a) => { 
    if (typeof a[0] === 'string' && a[0].includes('cdn.tailwindcss.com')) return; 
    _tw.apply(console, a); 
};
