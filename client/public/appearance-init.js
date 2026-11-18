// Blocking same-origin first paint; server settings reconcile after bootstrap.
(()=>{
 let preference='system';try{const value=localStorage.getItem('relay.appearance');if(value==='light'||value==='dark'||value==='system')preference=value;}catch{}
 const theme=preference==='system'?(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):preference;
 document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#1c201e':'#f7f5ef');
})();
