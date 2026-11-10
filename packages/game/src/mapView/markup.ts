export const markup = `<style>
    :host { color:#e7edf7; font:14px system-ui; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    section { height:100%; display:flex; flex-direction:column; background:#111c2ef5;
      border:1px solid #52627b; border-radius:10px; padding:16px; gap:12px; }
    header { display:flex; align-items:center; gap:12px; }
    h2 { margin:0; font-size:18px; flex:1; }
    button, select { font:inherit; color:inherit; background:#26364e; border:1px solid #52627b;
      border-radius:5px; padding:6px 10px; cursor:pointer; }
    button:hover:not(:disabled), button[aria-pressed=true] { background:#40516d; border-color:#ffb648; }
    button:disabled { opacity:.5; cursor:default; }
    .body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(340px,42%); gap:16px; }
    .map { min-width:0; min-height:0; display:flex; flex-direction:column; gap:10px; }
    .viewport { flex:1; min-height:0; position:relative; overflow:hidden; border:1px solid #52627b; border-radius:5px; }
    canvas { display:block; width:100%; height:100%; touch-action:none; cursor:grab; }
    .tile-action { display:flex; align-items:center; gap:8px; min-height:32px; }
    .tile-action span { flex:1; color:#bac6d8; }
    .tile-action button, .event-actions button { flex-shrink:0; }
    .legend { display:flex; gap:6px 14px; flex-wrap:wrap; font-size:12px; }
    .legend span { display:flex; align-items:center; gap:5px; }
    .legend canvas { width:22px; height:22px; cursor:default; }
    aside { min-height:0; display:flex; flex-direction:column; gap:10px; }
    label { display:flex; align-items:flex-start; gap:6px; }
    #events { flex:0 1 40%; min-height:120px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
    #events button { text-align:left; flex-shrink:0; overflow-wrap:anywhere; padding:5px 8px; line-height:1.3; }
    #events small { display:block; color:#bac6d8; margin-top:2px; font-size:12px; line-height:1.3; }
    #detail { flex:1; min-height:0; overflow:auto; overflow-wrap:anywhere; border:1px solid #52627b; border-radius:5px; padding:8px; }
    .event-header { display:flex; flex-direction:column; gap:3px; margin-bottom:8px; }
    .event-header strong { font-size:16px; }
    .event-header small, .page-meta { color:#bac6d8; }
    .event-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
    #map-status { margin:0; color:#ffcf7a; min-height:1.2em; }
    .self-switches { display:flex; flex-wrap:wrap; gap:6px 12px; }
    .self-switches label { align-items:center; }
    .self-switch-note { color:#bac6d8; font-size:12px; }
    .page { border:1px solid #52627b; border-radius:5px; padding:7px; margin-top:7px; }
    .page.applies { border-color:#ffb648; box-shadow:inset 3px 0 #ffb648; }
    .page-title { display:flex; align-items:flex-start; gap:6px; font-weight:600; }
    .page-title span:first-child { flex:1; }
    span.applies { color:#ffcf7a; }
    .page-meta { margin-top:3px; font-size:12px; }
    .sprite-picture { width:auto; height:32px; max-width:64px; display:inline-block; vertical-align:middle; image-rendering:pixelated; cursor:default; margin-left:5px; }
    .conditions { display:flex; flex-direction:column; gap:3px; margin-top:6px; }
    .condition { display:flex; gap:5px; font-size:12px; }
    .condition.held > span { color:#56e39a; }
    .condition.missing > span { color:#ff8b8b; }
    .command-list { display:flex; flex-direction:column; gap:4px; margin-top:7px; }
    .command-block { margin-left:12px; }
    .command-block > summary, .common-event > summary, .commands-toggle > summary { cursor:pointer; }
    summary:focus { outline:none; }
    summary:focus-visible { outline:1px solid #fff; }
    .command-line { display:block; padding:2px 0; }
    summary > .command-line { display:inline-block; vertical-align:top; max-width:calc(100% - 20px); }
    .command-line strong { font-weight:700; }
    .command-detail { white-space:pre-wrap; }
    .script-code { display:block; margin:5px 0 0; white-space:pre-wrap; overflow-wrap:anywhere;
      font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .script-code code { font:inherit; }
    .command-children { display:flex; flex-direction:column; gap:4px; margin:3px 0 0 12px; }
    .common-event { margin:3px 0 0 12px; }
    .common-event-content { margin:3px 0 0 12px; }
    .raw-code { display:block; color:#bac6d8; font:11px ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; }
    .commands-toggle { margin-top:7px; }
    .commands-toggle > summary { color:#ffcf7a; }
    #tooltip { position:absolute; pointer-events:none; background:#111c2e; border:1px solid #52627b;
      padding:6px 8px; border-radius:4px; max-width:calc(100% - 8px); font-size:12px; }
    @container (width < 700px) {
      section { overflow:auto; }
      .body { display:flex; flex:none; flex-direction:column; gap:6px; }
      .map { flex:0 0 220px; min-height:0; }
      .legend { gap:3px 8px; line-height:18px; }
      aside { flex:none; min-height:0; gap:6px; }
      #events { max-height:none; min-height:0; overflow:visible; flex:none; gap:3px; }
      #events button { padding:3px 6px; line-height:normal; }
      #events small { margin-top:1px; font-size:inherit; line-height:normal; }
      #detail { overflow:visible; flex:none; padding:6px; font-size:13px; }
      .event-header { gap:2px; margin-bottom:4px; }
      .event-header strong { font-size:15px; }
      .page { padding:5px; margin-top:5px; }
      .conditions { margin-top:4px; }
      .command-list { gap:2px; margin-top:5px; }
    }
    :host { container-type:inline-size; }
    @media (max-width:450px) { section { padding:8px; gap:8px; } .legend { gap:3px 8px; } }
  </style>
  <section role="dialog" aria-label="Map view"><header><h2 id="title">Map view</h2><select id="map-picker" aria-label="Map"></select><button id="back" hidden>Back to my map</button><button id="close">Close</button></header>
    <p id="map-status" hidden></p>
    <p id="empty" hidden>Start a new game or load a save first.</p>
    <div class="body" id="body"><div class="map"><div class="viewport"><canvas id="map" aria-label="Passability map"></canvas><div id="tooltip" hidden></div></div>
      <div class="tile-action"><span id="tile-selection">Click a tile or an event</span><button id="teleport-tile" disabled>Teleport here</button></div>
      <div class="legend" id="legend"></div></div>
      <aside><label><input id="filter" type="checkbox">Only events that can still do something</label>
      <div id="events"></div><div id="detail"></div></aside></div>
  </section>`;
