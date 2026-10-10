/* Editor v0.4 — jogadores, times, idade/país, transferências e idiomas (PT/EN/ES)
 * Roda como content script em mobagm.com. Content scripts compartilham o
 * IndexedDB da origem da página, então lemos/gravamos o save direto.
 */
(() => {
  const IS_NODE = typeof window === 'undefined';
  if (!IS_NODE && window.__mgmEditor) return;
  if (!IS_NODE) window.__mgmEditor = true;

  // ---------- Definições ----------
  const SKILLS = [
    ['mechanics', 'Mecânica'], ['reactions', 'Reações'], ['positioning', 'Posicionamento'],
    ['awareness', 'Percepção'], ['decisions', 'Decisões'], ['farmingEfficiency', 'Eficiência de farm'],
    ['itemization', 'Itemização'], ['communication', 'Comunicação'], ['adaptability', 'Adaptabilidade'],
    ['consistency', 'Consistência'], ['focus', 'Foco'], ['resilience', 'Resiliência'],
    ['volatility', 'Volatilidade'], ['greed', 'Ganância'], ['aggression', 'Agressividade'],
  ];
  const BULK_SKILLS = SKILLS.map(s => s[0]).filter(k => !['volatility', 'greed', 'aggression'].includes(k));
  const ATTRS = [
    ['morale', 'Moral'], ['leadership', 'Liderança'], ['pressure', 'Pressão'], ['loyalty', 'Lealdade'],
    ['relationships', 'Relacionamentos'], ['regionalLoyalty', 'Lealdade regional'],
    ['learningSpeed', 'Aprendizado'], ['drive', 'Determinação'], ['greed', 'Ganância'],
  ];
  const ROLES = ['Carry', 'Mid', 'Offlane', 'Soft Support', 'Hard Support'];
  const SLOT_LABEL = { Active: 'Titular', Substitute: 'Reserva', Academy: 'Academia' };
  const BACKUP_FIELDS = ['skills', 'attributes', 'roleAffinities', 'heroPool', 'ovr', 'pot', 'contract', 'activeRole', 'born'];
  const SEASON_FIELDS = ['skills', 'ovr', 'pot', 'contract', 'activeRole'];
  const TEAM_BACKUP_FIELDS = ['name', 'tag', 'logoUrl', 'finances', 'trainingInvestment', 'academyInvestment', 'reputation', 'elo'];
  const USERTEAM_SYNC = ['name', 'tag', 'logoUrl', 'finances', 'trainingInvestment', 'academyInvestment', 'roster', 'substitutes', 'academy'];

  // ---------- IndexedDB ----------
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('transação abortada')); });
  const clone = o => JSON.parse(JSON.stringify(o));
  const pick = (o, keys) => { const r = {}; for (const k of keys) if (o && k in o) r[k] = clone(o[k]); return r; };
  const REPLACE_KEYS = new Set(['heroPool']);
  function applyPatch(target, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (REPLACE_KEYS.has(k)) target[k] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') target[k] = { ...target[k], ...v };
      else target[k] = v;
    }
  }

  // ---------- Lógica de times/elencos (testável fora do navegador) ----------
  function makeCtx(tx, want) {
    const st = n => tx.objectStore(n);
    const ctx = {
      st, has: n => want.includes(n),
      teamsCache: new Map(), dirtyTeams: new Set(), psMap: null, psDirty: new Set(),
      player: id => req(st('players').get(id)),
      async team(id) {
        if (id == null || id <= 0) return null;
        if (!ctx.teamsCache.has(id)) ctx.teamsCache.set(id, await req(st('teams').get(id)));
        return ctx.teamsCache.get(id) || null;
      },
      async latestPS(pid) {
        if (!ctx.has('playerSeasons')) return null;
        if (!ctx.psMap) {
          const all = await req(st('playerSeasons').getAll());
          ctx.psMap = new Map();
          for (const s of all) { const c = ctx.psMap.get(s.playerId); if (!c || s.year >= c.year) ctx.psMap.set(s.playerId, s); }
        }
        return ctx.psMap.get(pid) || null;
      },
      async flush() {
        for (const id of ctx.dirtyTeams) await req(st('teams').put(ctx.teamsCache.get(id)));
        for (const s of ctx.psDirty) await req(st('playerSeasons').put(s));
        // o jogo guarda uma cópia do time do usuário em gameAttributes.userTeam
        if (ctx.has('gameAttributes') && st('gameAttributes').keyPath === 'key') {
          const ga = st('gameAttributes');
          const uid = (await req(ga.get('userTeamId')))?.value;
          if (uid != null && ctx.teamsCache.has(uid)) {
            const rec = await req(ga.get('userTeam'));
            if (rec && rec.value) {
              const t = ctx.teamsCache.get(uid);
              for (const k of USERTEAM_SYNC) if (k in t) rec.value[k] = clone(t[k]);
              await req(ga.put(rec));
            }
          }
        }
      },
    };
    return ctx;
  }

  function removeFromTeam(team, pid) {
    let old = null;
    for (const r of Object.keys(team.roster || {})) if (team.roster[r] && team.roster[r].playerId === pid) { old = team.roster[r]; team.roster[r] = null; }
    if (team.substitutes) team.substitutes = team.substitutes.filter(e => { if (e && e.playerId === pid) { old = e; return false; } return true; });
    for (const r of Object.keys(team.academy || {})) if (team.academy[r] && team.academy[r].playerId === pid) { old = team.academy[r]; team.academy[r] = null; }
    return old;
  }
  const academyRoleOf = (team, pid) => Object.keys((team && team.academy) || {}).find(r => team.academy[r] && team.academy[r].playerId === pid) || null;
  const makeEntry = (p, team, role, old) => ({
    playerId: p.playerId, username: p.username,
    rating: old && old.rating != null ? old.rating : p.ovr,
    role: role ?? null,
    value: old && old.value != null ? old.value : (p.value ?? 0),
    salary: p.contract ? p.contract.value : 0,
    expiry: p.contract ? p.contract.expires : 0,
    import: !!(p.born && p.born.region !== team.region),
  });
  function refreshEntries(team, p) {
    const fix = e => { if (e && e.playerId === p.playerId) { e.username = p.username; e.salary = p.contract ? p.contract.value : 0; e.expiry = p.contract ? p.contract.expires : 0; e.import = !!(p.born && p.born.region !== team.region); } };
    Object.values(team.roster || {}).forEach(fix); (team.substitutes || []).forEach(fix); Object.values(team.academy || {}).forEach(fix);
  }

  async function placePlayer(ctx, p, team, slot, role, contract, oldEntry) {
    team.roster ||= {}; team.academy ||= {}; team.substitutes ||= [];
    const old = removeFromTeam(team, p.playerId) || oldEntry || null;
    if (contract !== undefined) p.contract = contract;
    p.teamId = team.teamId; p.teamTag = team.tag; p.rosterSlot = slot; p.activeRole = slot === 'Active' ? role : null;
    const e = makeEntry(p, team, slot === 'Substitute' ? null : role, old);
    if (slot === 'Active') team.roster[role] = e; else if (slot === 'Academy') team.academy[role] = e; else team.substitutes.push(e);
    ctx.dirtyTeams.add(team.teamId);
    await req(ctx.st('players').put(p));
    const ps = await ctx.latestPS(p.playerId);
    if (ps) { ps.teamId = team.teamId; ps.rosterSlot = slot; ps.activeRole = p.activeRole; if (p.contract) ps.contract = { ...p.contract }; ctx.psDirty.add(ps); }
  }
  async function releasePlayer(ctx, p) {
    const t = await ctx.team(p.teamId);
    if (t) { removeFromTeam(t, p.playerId); ctx.dirtyTeams.add(t.teamId); }
    p.teamId = -1; p.teamTag = null; p.rosterSlot = null; p.activeRole = null; p.contract = null;
    await req(ctx.st('players').put(p));
  }

  // o = { teamId (-1 = agente livre), slot, role, salary, expires, policy: 'bench' | 'swap' | 'free' }
  async function doTransfer(ctx, pid, o) {
    const warnings = [];
    const p = await ctx.player(pid);
    if (!p) throw new Error('Jogador não encontrado no banco.');
    const fromTeam = await ctx.team(p.teamId);
    const fromSlot = p.rosterSlot;
    let fromRole = null;
    if (fromTeam) fromRole = fromSlot === 'Active' ? p.activeRole : fromSlot === 'Academy' ? academyRoleOf(fromTeam, pid) : null;
    const holeCheck = () => {
      if (!fromTeam) return;
      if (fromSlot === 'Active' && fromRole && !(fromTeam.roster || {})[fromRole]) warnings.push({ kind: 'active', tag: fromTeam.tag, role: fromRole });
      if (fromSlot === 'Academy' && fromRole && !(fromTeam.academy || {})[fromRole]) warnings.push({ kind: 'academy', tag: fromTeam.tag, role: fromRole });
    };

    if (o.teamId === -1) {
      if (p.teamId === -1) return { warnings };
      await releasePlayer(ctx, p);
      holeCheck();
      await ctx.flush();
      return { warnings };
    }

    const to = await ctx.team(o.teamId);
    if (!to) throw new Error('Time de destino não encontrado.');
    if (o.slot !== 'Substitute' && !o.role) throw new Error('Escolha a role da vaga.');
    to.roster ||= {}; to.academy ||= {}; to.substitutes ||= [];

    if (p.teamId === to.teamId && fromSlot === o.slot && (o.slot === 'Substitute' || fromRole === o.role)) {
      // mesma vaga: só atualiza o contrato
      await placePlayer(ctx, p, to, o.slot, o.role, { value: o.salary, expires: o.expires });
      await ctx.flush();
      return { warnings };
    }

    const occ = o.slot === 'Active' ? to.roster[o.role] : o.slot === 'Academy' ? to.academy[o.role] : null;
    const occP = occ && occ.playerId !== pid ? await ctx.player(occ.playerId) : null;

    const oldEntry = fromTeam ? removeFromTeam(fromTeam, pid) : null;
    if (fromTeam) ctx.dirtyTeams.add(fromTeam.teamId);

    if (occP) {
      removeFromTeam(to, occP.playerId);
      if (o.policy === 'free') await releasePlayer(ctx, occP);
      else if (o.policy === 'swap' && fromTeam) {
        const needsRole = fromSlot !== 'Substitute';
        if (needsRole && !fromRole) await placePlayer(ctx, occP, fromTeam, 'Substitute', null, undefined);
        else await placePlayer(ctx, occP, fromTeam, fromSlot, fromRole, undefined);
      } else if (o.policy === 'swap') await releasePlayer(ctx, occP);
      else await placePlayer(ctx, occP, to, 'Substitute', null, undefined);
    }
    await placePlayer(ctx, p, to, o.slot, o.role, { value: o.salary, expires: o.expires }, oldEntry);
    holeCheck();
    await ctx.flush();
    return { warnings };
  }

  if (IS_NODE) { module.exports = { makeCtx, doTransfer, removeFromTeam, academyRoleOf, refreshEntries, applyPatch }; return; }

  // ---------- Acesso ao IndexedDB (navegador) ----------
  const openDb = name => new Promise((res, rej) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); res(r.result); };
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('Banco bloqueado'));
  });
  async function withDb(name, fn) {
    const db = await openDb(name);
    try { return await fn(db); } finally { db.close(); }
  }
  async function findWorlds() {
    if (!indexedDB.databases) return [];
    const out = [];
    for (const d of await indexedDB.databases()) {
      try {
        await withDb(d.name, async db => {
          if (db.objectStoreNames.contains('players') && db.objectStoreNames.contains('teams')) out.push(d.name);
        });
      } catch (e) { /* ignora */ }
    }
    return out;
  }
  async function mutate(fn) {
    return withDb(S.world, async db => {
      const want = ['players', 'teams', 'playerSeasons', 'gameAttributes'].filter(n => db.objectStoreNames.contains(n));
      const tx = db.transaction(want, 'readwrite');
      const out = await fn(tx, want);
      await done(tx);
      return out;
    });
  }

  // ---------- Estado ----------
  const S = {
    world: null, players: [], teams: new Map(), heroes: new Map(), heroList: [], worlds: [], countries: [], psInfo: new Map(),
    year: null, tab: 'players', sel: null, selTeam: null, autoReload: false, flash: null, transferTarget: null,
    filter: { q: '', team: '' }, tfilter: { q: '', region: '' },
  };

  async function loadWorld(name) {
    S.world = name;
    await withDb(name, async db => {
      const want = ['players', 'teams', 'heroes', 'countries', 'gameAttributes', 'playerSeasons'].filter(n => db.objectStoreNames.contains(n));
      const tx = db.transaction(want, 'readonly');
      const get = n => want.includes(n) ? req(tx.objectStore(n).getAll()) : Promise.resolve([]);
      const [players, teams, heroes, countries, ga, ps] = await Promise.all(['players', 'teams', 'heroes', 'countries', 'gameAttributes', 'playerSeasons'].map(get));
      S.players = players.filter(p => p && (p.retiredYear === -1 || p.retiredYear == null));
      S.teams = new Map(teams.map(t => [t.teamId, t]));
      S.heroes = new Map(heroes.map(x => [String(x.heroId), x.name]));
      S.heroList = heroes.slice().sort((a, b) => a.name.localeCompare(b.name));
      S.countries = countries;
      S.year = ga.find(g => g.key === 'year')?.value ?? new Date().getFullYear();
      S.psInfo = new Map();
      for (const s of ps) { const c = S.psInfo.get(s.playerId); if (!c || s.year >= c.year) S.psInfo.set(s.playerId, { year: s.year, age: s.age }); }
    });
    S.players.sort((a, b) => (b.ovr || 0) - (a.ovr || 0));
  }

  // ---------- Salvar / restaurar ----------
  const bkKey = (w, id) => `mgm_bk:${w}:${id}`;
  const tbkKey = (w, id) => `mgm_tbk:${w}:${id}`;
  async function backupOnce(key, storeName, id, fields) {
    const have = await chrome.storage.local.get(key);
    if (have[key]) return;
    const orig = await withDb(S.world, db => req(db.transaction(storeName, 'readonly').objectStore(storeName).get(id)));
    if (orig) await chrome.storage.local.set({ [key]: { ts: Date.now(), fields: pick(orig, fields) } });
  }

  async function savePlayer(playerId, patch, { syncSeason = true, makeBackup = true } = {}) {
    if (makeBackup) await backupOnce(bkKey(S.world, playerId), 'players', playerId, BACKUP_FIELDS);
    return mutate(async (tx, want) => {
      const ctx = makeCtx(tx, want);
      const cur = await ctx.player(playerId);
      if (!cur) throw new Error('Jogador não encontrado no banco.');
      applyPatch(cur, patch);
      await req(ctx.st('players').put(cur));
      if (syncSeason) {
        const ps = await ctx.latestPS(playerId);
        if (ps) {
          applyPatch(ps, pick(patch, SEASON_FIELDS));
          if (patch.born && cur.born && cur.born.year != null) ps.age = ps.year - cur.born.year;
          ctx.psDirty.add(ps);
        }
      }
      const t = await ctx.team(cur.teamId);
      if (t) { refreshEntries(t, cur); ctx.dirtyTeams.add(t.teamId); }
      await ctx.flush();
      return cur;
    });
  }
  async function restorePlayer(playerId) {
    const key = bkKey(S.world, playerId);
    const have = await chrome.storage.local.get(key);
    if (!have[key]) throw new Error('Não há backup desse jogador (ele ainda não foi editado).');
    return savePlayer(playerId, have[key].fields, { makeBackup: false });
  }

  async function saveTeam(teamId, patch, { makeBackup = true } = {}) {
    if (makeBackup) await backupOnce(tbkKey(S.world, teamId), 'teams', teamId, TEAM_BACKUP_FIELDS);
    return mutate(async (tx, want) => {
      const ctx = makeCtx(tx, want);
      const t = await ctx.team(teamId);
      if (!t) throw new Error('Time não encontrado.');
      applyPatch(t, patch);
      ctx.dirtyTeams.add(teamId);
      if (patch.tag !== undefined) {
        const all = await req(ctx.st('players').getAll());
        for (const p of all) if (p.teamId === teamId && p.teamTag !== t.tag) { p.teamTag = t.tag; await req(ctx.st('players').put(p)); }
      }
      await ctx.flush();
      return t;
    });
  }
  async function restoreTeam(teamId) {
    const key = tbkKey(S.world, teamId);
    const have = await chrome.storage.local.get(key);
    if (!have[key]) throw new Error('Não há backup desse time (ele ainda não foi editado).');
    return saveTeam(teamId, have[key].fields, { makeBackup: false });
  }

  const transfer = (pid, o) => mutate((tx, want) => doTransfer(makeCtx(tx, want), pid, o));

  async function exportBackup() {
    const out = await withDb(S.world, async db => {
      const tx = db.transaction(['players', 'teams'], 'readonly');
      const [players, teams] = await Promise.all([req(tx.objectStore('players').getAll()), req(tx.objectStore('teams').getAll())]);
      return { players, teams };
    });
    const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mobagm-editor-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- UI ----------
  // ---------- Idiomas (PT-BR é o texto-base; EN e ES são traduções por chave) ----------
  let LANG = 'pt';
  const LOCALES = { pt: 'pt-BR', en: 'en-US', es: 'es-ES' };
  const I18N = {
    en: {
      'O jogo pode manter dados em memória; recarregar evita que ele sobrescreva a edição.': 'The game may keep data in memory; reloading prevents it from overwriting your edit.',
      'F5 automático após salvar': 'Auto-reload (F5) after saving', 'Exportar backup': 'Export backup',
      'Jogadores': 'Players', 'Times': 'Teams',
      'Buscar nick, nome, time, país, role…': 'Search nickname, name, team, country, role…',
      'Todos os times': 'All teams', 'Sem time (agentes livres)': 'No team (free agents)',
      'Buscar time…': 'Search team…', 'Todas as regiões': 'All regions',
      'Nenhum save encontrado neste navegador. Abra um jogo no Moba GM, carregue o save e tente de novo.': 'No save found in this browser. Open a game in Moba GM, load your save and try again.',
      'Nenhum jogador encontrado.': 'No players found.', 'Nenhum time encontrado.': 'No teams found.', 'Sem time': 'No team',
      'Selecione um jogador à esquerda.': 'Select a player on the left.', 'Selecione um time à esquerda.': 'Select a team on the left.',
      'Geral': 'General', 'Habilidades': 'Skills', 'Atributos': 'Attributes', 'Afinidade de role (0–5)': 'Role affinity (0–5)',
      'Pool de heróis (maestria)': 'Hero pool (mastery)', 'Adicionar heróis ao pool': 'Add heroes to the pool', 'Time e vaga': 'Team and slot',
      'Role ativa': 'Active role', 'Role ativa (só titulares)': 'Active role (starters only)', 'Salário (contrato)': 'Salary (contract)',
      'Contrato expira em': 'Contract expires in', 'País': 'Country', 'Região': 'Region',
      'Mecânica': 'Mechanics', 'Reações': 'Reactions', 'Posicionamento': 'Positioning', 'Percepção': 'Awareness', 'Decisões': 'Decisions',
      'Eficiência de farm': 'Farming efficiency', 'Itemização': 'Itemization', 'Comunicação': 'Communication', 'Adaptabilidade': 'Adaptability',
      'Consistência': 'Consistency', 'Foco': 'Focus', 'Resiliência': 'Resilience', 'Volatilidade': 'Volatility', 'Ganância': 'Greed', 'Agressividade': 'Aggression',
      'Moral': 'Morale', 'Liderança': 'Leadership', 'Pressão': 'Pressure', 'Lealdade': 'Loyalty', 'Relacionamentos': 'Relationships',
      'Lealdade regional': 'Regional loyalty', 'Aprendizado': 'Learning speed', 'Determinação': 'Drive',
      'Todas as skills de jogo =': 'All gameplay skills =', 'Aplicar': 'Apply', 'OVR = média das 12 skills': 'OVR = average of the 12 skills',
      'Filtrar heróis do pool…': 'Filter pool heroes…', 'Maestria dos heróis visíveis =': 'Mastery of visible heroes =', 'Remover do pool': 'Remove from pool',
      'Pesquisar herói por nome ou tipo…': 'Search hero by name or type…', 'Maestria inicial': 'Initial mastery',
      'Adicionar todos os resultados': 'Add all results', '+ Adicionar': '+ Add', 'Nenhum herói encontrado.': 'No heroes found.',
      'Agente livre (sem time)': 'Free agent (no team)', 'Time': 'Team', 'Vaga': 'Slot', 'Role da vaga': 'Slot role', 'Salário': 'Salary',
      'Contrato até': 'Contract until', 'Se a vaga estiver ocupada': 'If the slot is taken',
      'Mandar o ocupante para a reserva': 'Move the occupant to the bench', 'Trocar de lugar com o ocupante': 'Swap places with the occupant',
      'Mandar o ocupante para agentes livres': 'Release the occupant to free agents', 'Transferir / alocar': 'Transfer / assign',
      'Aplica na hora, separado do botão “Salvar alterações”. Exporte um backup antes.': 'Applies immediately, separate from the “Save changes” button. Export a backup first.',
      'Titular': 'Starter', 'Reserva': 'Bench', 'Academia': 'Academy',
      'Salvar alterações': 'Save changes', 'Restaurar original': 'Restore original', 'sincronizar temporada atual': 'sync current season', 'Agente livre': 'Free agent',
      'Dados do time': 'Team data', 'Nome': 'Name', 'Caixa': 'Cash', 'Patrocínio': 'Sponsorship',
      'Investimento em treino (0–3)': 'Training investment (0–3)', 'Investimento na academia (0–3)': 'Academy investment (0–3)',
      'Reputação (0–100)': 'Reputation (0–100)', 'Salvar time': 'Save team', 'Elenco': 'Roster', 'Jogador': 'Player', 'Até': 'Until',
      'Editar': 'Edit', 'Liberar': 'Release', 'Contratar agente livre…': 'Sign a free agent…',
      'Para trazer jogador de outro time, abra-o na aba Jogadores e use “Time e vaga”.': 'To bring in a player from another team, open him in the Players tab and use “Team and slot”.',
      'Salvo!': 'Saved!', 'Time salvo!': 'Team saved!', 'Valores originais restaurados.': 'Original values restored.',
      'Valores originais do time restaurados.': 'Team’s original values restored.', 'Atenção:': 'Warning:',
      'Recarregando a página…': 'Reloading the page…', 'Recarregue (F5) quando quiser que o jogo leia os novos valores.': 'Reload (F5) whenever you want the game to read the new values.',
      'Erro ao salvar:': 'Error while saving:', 'Erro:': 'Error:', 'Erro ao transferir:': 'Error while transferring:',
      'Jogador não encontrado no banco.': 'Player not found in the database.', 'Time de destino não encontrado.': 'Destination team not found.',
      'Escolha a role da vaga.': 'Choose the slot role.', 'Não há backup desse jogador (ele ainda não foi editado).': 'No backup for this player (he hasn’t been edited yet).',
      'Time não encontrado.': 'Team not found.', 'Não há backup desse time (ele ainda não foi editado).': 'No backup for this team (it hasn’t been edited yet).',
      'Banco bloqueado': 'Database blocked', 'transação abortada': 'transaction aborted',
      'Idade (em {y})': 'Age (in {y})', '{n} herói(s) fora do pool': '{n} hero(es) outside the pool',
      '{u} agora é agente livre.': '{u} is now a free agent.', '{u} alocado em {t} ({s}).': '{u} assigned to {t} ({s}).',
      'Escolha um agente livre e use “Time e vaga” para alocá-lo em {t}.': 'Pick a free agent and use “Team and slot” to assign him to {t}.',
      'Liberar {u} para agentes livres? O contrato dele será removido.': 'Release {u} to free agents? His contract will be removed.',
      'Vagas de titular vazias: {l}.': 'Empty starter slots: {l}.',
      '{t}: a vaga de titular ({r}) ficou vazia.': '{t}: the starter slot ({r}) is now empty.',
      '{t}: a vaga da academia ({r}) ficou vazia.': '{t}: the academy slot ({r}) is now empty.',
      'Herói #{id}': 'Hero #{id}', '{c} ({r}) · {a} anos': '{c} ({r}) · {a} years old',
      '{r} · Div {d} · caixa {c}': '{r} · Div {d} · cash {c}', '{r} · Divisão {d}': '{r} · Division {d}',
    },
    es: {
      'O jogo pode manter dados em memória; recarregar evita que ele sobrescreva a edição.': 'El juego puede guardar datos en memoria; recargar evita que sobrescriba tu edición.',
      'F5 automático após salvar': 'F5 automático al guardar', 'Exportar backup': 'Exportar copia de seguridad',
      'Jogadores': 'Jugadores', 'Times': 'Equipos',
      'Buscar nick, nome, time, país, role…': 'Buscar nick, nombre, equipo, país, rol…',
      'Todos os times': 'Todos los equipos', 'Sem time (agentes livres)': 'Sin equipo (agentes libres)',
      'Buscar time…': 'Buscar equipo…', 'Todas as regiões': 'Todas las regiones',
      'Nenhum save encontrado neste navegador. Abra um jogo no Moba GM, carregue o save e tente de novo.': 'No se encontró ninguna partida guardada en este navegador. Abre una partida en Moba GM, carga tu guardado e inténtalo de nuevo.',
      'Nenhum jogador encontrado.': 'No se encontraron jugadores.', 'Nenhum time encontrado.': 'No se encontraron equipos.', 'Sem time': 'Sin equipo',
      'Selecione um jogador à esquerda.': 'Selecciona un jugador a la izquierda.', 'Selecione um time à esquerda.': 'Selecciona un equipo a la izquierda.',
      'Geral': 'General', 'Afinidade de role (0–5)': 'Afinidad de rol (0–5)',
      'Pool de heróis (maestria)': 'Pool de héroes (maestría)', 'Adicionar heróis ao pool': 'Añadir héroes al pool', 'Time e vaga': 'Equipo y puesto',
      'Role ativa': 'Rol activo', 'Role ativa (só titulares)': 'Rol activo (solo titulares)', 'Salário (contrato)': 'Salario (contrato)',
      'Contrato expira em': 'El contrato vence en', 'Região': 'Región',
      'Mecânica': 'Mecánica', 'Reações': 'Reacciones', 'Posicionamento': 'Posicionamiento', 'Percepção': 'Percepción', 'Decisões': 'Decisiones',
      'Eficiência de farm': 'Eficiencia de farmeo', 'Itemização': 'Itemización', 'Comunicação': 'Comunicación', 'Adaptabilidade': 'Adaptabilidad',
      'Consistência': 'Consistencia', 'Foco': 'Enfoque', 'Resiliência': 'Resiliencia', 'Volatilidade': 'Volatilidad', 'Ganância': 'Codicia', 'Agressividade': 'Agresividad',
      'Liderança': 'Liderazgo', 'Pressão': 'Presión', 'Lealdade': 'Lealtad', 'Relacionamentos': 'Relaciones',
      'Lealdade regional': 'Lealtad regional', 'Aprendizado': 'Aprendizaje', 'Determinação': 'Determinación',
      'Todas as skills de jogo =': 'Todas las habilidades de juego =', 'OVR = média das 12 skills': 'OVR = promedio de las 12 habilidades',
      'Filtrar heróis do pool…': 'Filtrar héroes del pool…', 'Maestria dos heróis visíveis =': 'Maestría de los héroes visibles =', 'Remover do pool': 'Quitar del pool',
      'Pesquisar herói por nome ou tipo…': 'Buscar héroe por nombre o tipo…', 'Maestria inicial': 'Maestría inicial',
      'Adicionar todos os resultados': 'Añadir todos los resultados', '+ Adicionar': '+ Añadir', 'Nenhum herói encontrado.': 'No se encontraron héroes.',
      'Agente livre (sem time)': 'Agente libre (sin equipo)', 'Time': 'Equipo', 'Vaga': 'Puesto', 'Role da vaga': 'Rol del puesto', 'Salário': 'Salario',
      'Contrato até': 'Contrato hasta', 'Se a vaga estiver ocupada': 'Si el puesto está ocupado',
      'Mandar o ocupante para a reserva': 'Enviar al ocupante al banquillo', 'Trocar de lugar com o ocupante': 'Intercambiar lugar con el ocupante',
      'Mandar o ocupante para agentes livres': 'Enviar al ocupante a agentes libres', 'Transferir / alocar': 'Transferir / asignar',
      'Aplica na hora, separado do botão “Salvar alterações”. Exporte um backup antes.': 'Se aplica al instante, aparte del botón “Guardar cambios”. Exporta una copia de seguridad antes.',
      'Reserva': 'Suplente',
      'Salvar alterações': 'Guardar cambios', 'sincronizar temporada atual': 'sincronizar temporada actual', 'Agente livre': 'Agente libre',
      'Dados do time': 'Datos del equipo', 'Nome': 'Nombre', 'Caixa': 'Caja', 'Patrocínio': 'Patrocinio',
      'Investimento em treino (0–3)': 'Inversión en entrenamiento (0–3)', 'Investimento na academia (0–3)': 'Inversión en la academia (0–3)',
      'Reputação (0–100)': 'Reputación (0–100)', 'Salvar time': 'Guardar equipo', 'Elenco': 'Plantilla', 'Jogador': 'Jugador', 'Até': 'Hasta',
      'Contratar agente livre…': 'Fichar agente libre…',
      'Para trazer jogador de outro time, abra-o na aba Jogadores e use “Time e vaga”.': 'Para traer a un jugador de otro equipo, ábrelo en la pestaña Jugadores y usa “Equipo y puesto”.',
      'Salvo!': '¡Guardado!', 'Time salvo!': '¡Equipo guardado!', 'Valores originais restaurados.': 'Valores originales restaurados.',
      'Valores originais do time restaurados.': 'Valores originales del equipo restaurados.', 'Atenção:': 'Atención:',
      'Recarregando a página…': 'Recargando la página…', 'Recarregue (F5) quando quiser que o jogo leia os novos valores.': 'Recarga (F5) cuando quieras que el juego lea los nuevos valores.',
      'Erro ao salvar:': 'Error al guardar:', 'Erro ao transferir:': 'Error al transferir:', 'Erro:': 'Error:',
      'Jogador não encontrado no banco.': 'Jugador no encontrado en la base de datos.', 'Time de destino não encontrado.': 'Equipo de destino no encontrado.',
      'Escolha a role da vaga.': 'Elige el rol del puesto.', 'Não há backup desse jogador (ele ainda não foi editado).': 'No hay copia de seguridad de este jugador (aún no se ha editado).',
      'Time não encontrado.': 'Equipo no encontrado.', 'Não há backup desse time (ele ainda não foi editado).': 'No hay copia de seguridad de este equipo (aún no se ha editado).',
      'Banco bloqueado': 'Base de datos bloqueada', 'transação abortada': 'transacción abortada',
      'Idade (em {y})': 'Edad (en {y})', '{n} herói(s) fora do pool': '{n} héroe(s) fuera del pool',
      '{u} agora é agente livre.': '{u} ahora es agente libre.', '{u} alocado em {t} ({s}).': '{u} asignado a {t} ({s}).',
      'Escolha um agente livre e use “Time e vaga” para alocá-lo em {t}.': 'Elige un agente libre y usa “Equipo y puesto” para asignarlo a {t}.',
      'Liberar {u} para agentes livres? O contrato dele será removido.': '¿Liberar a {u} como agente libre? Se eliminará su contrato.',
      'Vagas de titular vazias: {l}.': 'Puestos de titular vacíos: {l}.',
      '{t}: a vaga de titular ({r}) ficou vazia.': '{t}: el puesto de titular ({r}) quedó vacío.',
      '{t}: a vaga da academia ({r}) ficou vazia.': '{t}: el puesto de la academia ({r}) quedó vacío.',
      'Herói #{id}': 'Héroe #{id}', '{c} ({r}) · {a} anos': '{c} ({r}) · {a} años',
      '{r} · Div {d} · caixa {c}': '{r} · Div {d} · caja {c}', '{r} · Divisão {d}': '{r} · División {d}',
    },
  };
  // preserva espaços nas pontas; textos que não estão no dicionário passam sem mudar
  const tr = s => {
    if (LANG === 'pt' || typeof s !== 'string') return s;
    const k = s.trim(); const t = I18N[LANG][k];
    return t === undefined ? s : s.replace(k, () => t);
  };
  const tf = (s, v) => tr(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));
  const slotLabel = k => tr(SLOT_LABEL[k] || '—');
  const fmtWarn = w => tf(w.kind === 'academy' ? '{t}: a vaga da academia ({r}) ficou vazia.' : '{t}: a vaga de titular ({r}) ficou vazia.', { t: w.tag, r: w.role });
  const savePrefs = () => chrome.storage.local.set({ mgm_prefs: { autoReload: S.autoReload, lang: LANG } });

  const FLAGS = {
    pt: '<svg viewBox="0 0 28 20" preserveAspectRatio="none"><rect width="28" height="20" fill="#009b3a"/><polygon points="14,2.2 25.6,10 14,17.8 2.4,10" fill="#ffdf00"/><circle cx="14" cy="10" r="4.3" fill="#002776"/><path d="M9.9 9.1C12.6 8 15.9 8.4 18.1 10.6" stroke="#fff" stroke-width="0.9" fill="none"/></svg>',
    en: '<svg viewBox="0 0 60 30" preserveAspectRatio="none"><clipPath id="ujs"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="ujt"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#ujs)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#ujt)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>',
    es: '<svg viewBox="0 0 28 20" preserveAspectRatio="none"><rect width="28" height="20" fill="#c60b1e"/><rect y="5" width="28" height="10" fill="#ffc400"/></svg>',
  };
  const SEARCH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';

  const h = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, (k === 'placeholder' || k === 'title' || k === 'aria-label') ? tr(v) : v);
    }
    for (const c of kids.flat()) e.append(c && c.nodeType ? c : document.createTextNode(typeof c === 'string' ? tr(c) : (c ?? '')));
    return e;
  };

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,Segoe UI,Roboto,sans-serif}
  .fab{display:none;position:fixed;right:16px;bottom:16px;z-index:2147483646;width:34px;height:34px;padding:0;align-items:center;justify-content:center;background:#6951e0;color:#fff;border:0;border-radius:6px;font-size:21px;line-height:1;cursor:pointer;font-family:'Segoe UI Symbol','Noto Sans Symbols 2','Apple Symbols',sans-serif}
  .fab:hover{background:#7a63ee}
  .fab .ic{display:inline-block;transform:rotate(45deg)}
  .ov{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;z-index:2147483647}
  .ov.open{display:flex}
  .panel{position:relative;width:min(1200px,96vw);height:90vh;background:#15171c;color:#e6e8ee;border-radius:12px;display:flex;flex-direction:column;overflow:hidden;font-size:13px}
  .hd{display:flex;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid #2a2e38}
  .hd b{font-size:15px;margin-right:auto}
  .tabs{display:flex;gap:4px;padding:6px 14px 0;border-bottom:1px solid #2a2e38}
  .tabs button{border-radius:6px 6px 0 0;border-bottom:0;background:#1b1e26}
  .tabs button.active{background:#6d5efc;border-color:#6d5efc}
  .body{flex:1;display:flex;min-height:0}
  .left{width:340px;border-right:1px solid #2a2e38;display:flex;flex-direction:column;min-height:0}
  .filters{display:flex;gap:6px;padding:8px}
  .list{overflow:auto;flex:1}
  .row{display:block;width:100%;text-align:left;background:none;border:0;border-bottom:1px solid #20242c;color:inherit;padding:7px 10px;cursor:pointer}
  .row:hover{background:#1e222b}.row.sel{background:#2b2f66}
  .row small{color:#9aa1b2;display:block}
  .right{flex:1;overflow:auto;padding:14px}
  input,select,button{background:#20242c;color:#e6e8ee;border:1px solid #333948;border-radius:6px;padding:5px 8px;font-size:13px}
  button{cursor:pointer}button:hover{background:#2a2f3b}
  button.pri{background:#6d5efc;border-color:#6d5efc}button.pri:hover{background:#7f72ff}
  button.warn{border-color:#8a3a40;color:#ffb4b9}
  button:disabled,input:disabled,select:disabled{opacity:.45;cursor:not-allowed}
  input[type=number]{width:90px}
  .filters input{flex:1;min-width:0}
  .filters.col{flex-direction:column;gap:6px}
  .sbox{position:relative}
  .sbox input{width:100%;height:32px;padding-left:30px}
  .sbox .sico{position:absolute;left:9px;top:50%;transform:translateY(-50%);display:flex;color:#9aa1b2;pointer-events:none}
  .langs{display:flex;gap:4px}
  .langs button{padding:2px;border-radius:5px;display:flex;line-height:0;opacity:.55}
  .langs button.on{opacity:1;border-color:#6d5efc;box-shadow:0 0 0 1px #6d5efc}
  .langs svg{width:24px;height:16px;border-radius:2px;display:block}
  h3{margin:16px 0 8px;font-size:13px;color:#b8bdf5;text-transform:uppercase;letter-spacing:.04em}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px 18px}
  .f{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .f input[type=text],.f input[type=url]{width:170px}
  .wide{grid-column:1/-1}.wide input{flex:1;width:auto!important}
  .bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}
  .muted{color:#9aa1b2}
  .toast{margin:8px 0;padding:8px 10px;border-radius:6px;background:#1f3a2a}.toast.err{background:#4a2326}
  .heroes{max-height:260px;overflow:auto;border:1px solid #2a2e38;border-radius:8px;padding:8px}
  .gtoast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:#1f3a2a;padding:10px 14px;border-radius:8px;max-width:80%;box-shadow:0 4px 14px #0008;display:none;z-index:5}
  .gtoast.err{background:#4a2326}
  table{width:100%;border-collapse:collapse}
  td,th{padding:5px 6px;border-bottom:1px solid #20242c;text-align:left}
  th{color:#9aa1b2;font-weight:500}
  .box{border:1px solid #2a2e38;border-radius:8px;padding:10px;margin-top:6px;background:#181b22}
  `;

  const host = h('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
  document.documentElement.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', {}, CSS));

  const ov = h('div', { class: 'ov' });
  const fab = h('button', { class: 'fab', title: 'Editor', 'aria-label': 'Editor', onclick: () => toggle(true) }, h('span', { class: 'ic' }, '\u270F\uFE0E'));
  root.append(fab, ov);

  // Posiciona o botão logo à esquerda do botão do Discord do site (e o acompanha se a página mudar).
  // Se não achar o Discord, fica no canto inferior direito.
  let anchorEl = null, anchorGap = 7, lastSearch = 0;
  const t0 = performance.now();
  const rect = e => e.getBoundingClientRect();
  const DISCORD_SEL = 'a[href*="discord.gg"],a[href*="discord.com"],a[href*="discordapp"]';
  const BTN_SEL = 'a,button,[role="button"]';
  const clsOf = e => (typeof e.className === 'string' ? e.className : '');
  const metaOf = e => `${e.getAttribute('aria-label') || ''} ${e.title || ''} ${e.id || ''} ${clsOf(e)}`;
  const hasDiscordSvg = e => [...e.querySelectorAll('svg path')].some(pth => /^M(20\.317|524\.5)/.test((pth.getAttribute('d') || '').replace(/[\s,]/g, '')));
  function findDiscord() {
    if (anchorEl && anchorEl.isConnected && rect(anchorEl).width) return anchorEl;
    anchorEl = null;
    const now = performance.now();
    if (now - lastSearch < 700) return null;
    lastSearch = now;
    const all = [...document.querySelectorAll(BTN_SEL)];
    let d = document.querySelector(DISCORD_SEL) || all.find(e => /discord/i.test(metaOf(e)) || hasDiscordSvg(e));
    if (!d) {
      // fileira de botões de ícone no canto superior direito: o Discord é o mais à esquerda
      const c = all.filter(e => { const r = rect(e); return r.width >= 22 && r.width <= 56 && r.height >= 22 && r.height <= 56 && r.top < 90 && r.bottom > 0 && r.left > innerWidth * 0.55; })
        .filter((e, _, arr) => !arr.some(o => o !== e && e.contains(o)))
        .sort((x, y) => rect(y).left - rect(x).left);
      const chain = [];
      for (const e of c) {
        if (!chain.length) { chain.push(e); continue; }
        const prev = rect(chain[chain.length - 1]), r = rect(e);
        if (prev.left - r.right <= 16 && Math.abs(r.top - prev.top) < 6) chain.push(e); else break;
      }
      if (chain.length >= 2) { d = chain[chain.length - 1]; anchorGap = Math.max(4, Math.round(rect(chain[chain.length - 2]).left - rect(d).right)); }
    }
    if (!d) d = all.find(e => /discord/i.test(e.textContent || '')) || null;
    anchorEl = d;
    return d;
  }
  function placeFab() {
    const d = findDiscord();
    if (!d) {
      fab.removeAttribute('style');
      fab.style.display = performance.now() - t0 > 4000 ? 'flex' : 'none';
      return;
    }
    const r = rect(d);
    if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) { fab.style.display = 'none'; return; }
    const size = Math.max(28, Math.min(Math.round(r.height), 44));
    let left = r.left - size - anchorGap;
    if (left < 0) left = r.right + anchorGap;
    Object.assign(fab.style, {
      display: 'flex', position: 'fixed', right: 'auto', bottom: 'auto',
      left: Math.round(left) + 'px', top: Math.round(r.top + (r.height - size) / 2) + 'px',
      width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.62) + 'px',
      borderRadius: getComputedStyle(d).borderTopLeftRadius || '6px',
    });
  }
  let raf = 0;
  const schedulePlace = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeFab(); }); };
  addEventListener('scroll', schedulePlace, true);
  addEventListener('resize', schedulePlace);
  new MutationObserver(schedulePlace).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(schedulePlace, 500);
  schedulePlace();
  for (const ev of ['keydown', 'keyup', 'keypress']) ov.addEventListener(ev, e => e.stopPropagation());

  const els = {};
  async function toggle(open) {
    ov.classList.toggle('open', open);
    if (open && !els.built) await build();
    if (open) (S.tab === 'players' ? els.q : els.tq)?.focus();
  }

  const numIn = (v, min = 0, max = 100) => h('input', { type: 'number', min, max, step: 1, value: v ?? 0 });
  const numFIn = (v, min, max) => h('input', { type: 'number', min, max, step: 'any', value: v ?? 0 });
  const num = (el, fallback) => { const n = parseInt(el.value, 10); return Number.isFinite(n) ? n : fallback; };
  const numF = (el, fallback) => { const n = parseFloat(el.value); return Number.isFinite(n) ? n : fallback; };
  const field = (label, input, cls = '') => h('div', { class: 'f ' + cls }, h('span', {}, label), input);
  const byTag = (a, b) => (a.tag || '').localeCompare(b.tag || '');
  const teamLabel = id => { const t = S.teams.get(id); return t ? t.tag : tr('Sem time'); };
  const money = n => (n ?? 0).toLocaleString(LOCALES[LANG]);

  async function build() {
    els.built = true;
    const prefs = (await chrome.storage.local.get('mgm_prefs')).mgm_prefs || {};
    S.autoReload = !!prefs.autoReload;
    LANG = ['pt', 'en', 'es'].includes(prefs.lang) ? prefs.lang : 'pt';
    S.worlds = await findWorlds();
    buildShell();
    if (!S.worlds.length) {
      els.right.replaceChildren(h('p', {}, 'Nenhum save encontrado neste navegador. Abra um jogo no Moba GM, carregue o save e tente de novo.'));
      setTab('players', true);
      return;
    }
    await loadWorld(S.worlds[0]);
    els.worldSel.value = S.world;
    fillTeams();
    setTab('players');
  }

  function searchBox(input) {
    const ico = document.createElement('span');
    ico.className = 'sico'; ico.innerHTML = SEARCH_SVG;
    return h('div', { class: 'sbox' }, ico, input);
  }

  // monta (ou remonta, ao trocar de idioma) a moldura do painel
  function buildShell() {
    els.worldSel = h('select', { onchange: async e => { await loadWorld(e.target.value); S.sel = null; S.selTeam = null; fillTeams(); renderAll(); } });
    els.worldSel.replaceChildren(...S.worlds.map(w => h('option', { value: w }, w)));
    if (S.world) els.worldSel.value = S.world;
    els.toastEl = h('div', { class: 'gtoast' });
    const reloadCb = h('input', { type: 'checkbox', onchange: e => { S.autoReload = e.target.checked; savePrefs(); } });
    reloadCb.checked = S.autoReload;
    els.tabP = h('button', { onclick: () => setTab('players') }, 'Jogadores');
    els.tabT = h('button', { onclick: () => setTab('teams') }, 'Times');

    // aba jogadores: a busca fica numa linha própria, em largura total
    els.q = h('input', { type: 'search', placeholder: 'Buscar nick, nome, time, país, role…', value: S.filter.q, oninput: e => { S.filter.q = e.target.value.toLowerCase(); renderList(); } });
    els.team = h('select', { onchange: e => { S.filter.team = e.target.value; renderList(); } });
    els.list = h('div', { class: 'list' });
    els.right = h('div', { class: 'right' });
    els.pView = h('div', { class: 'body' }, h('div', { class: 'left' }, h('div', { class: 'filters col' }, searchBox(els.q), els.team), els.list), els.right);

    // aba times
    els.tq = h('input', { type: 'search', placeholder: 'Buscar time…', value: S.tfilter.q, oninput: e => { S.tfilter.q = e.target.value.toLowerCase(); renderTeamList(); } });
    els.treg = h('select', { onchange: e => { S.tfilter.region = e.target.value; renderTeamList(); } });
    els.tlist = h('div', { class: 'list' });
    els.tright = h('div', { class: 'right' });
    els.tView = h('div', { class: 'body' }, h('div', { class: 'left' }, h('div', { class: 'filters col' }, searchBox(els.tq), els.treg), els.tlist), els.tright);

    const langs = h('div', { class: 'langs' }, [['pt', 'Português (Brasil)'], ['en', 'English'], ['es', 'Español']].map(([code, name]) => {
      const b = h('button', { class: code === LANG ? 'on' : '', title: name, 'aria-label': name, onclick: () => setLang(code) });
      const sp = document.createElement('span'); sp.style.display = 'flex'; sp.innerHTML = FLAGS[code];
      b.append(sp);
      return b;
    }));

    const hd = h('div', { class: 'hd' },
      h('b', {}, 'Editor'),
      langs,
      els.worldSel,
      h('label', { title: 'O jogo pode manter dados em memória; recarregar evita que ele sobrescreva a edição.' }, reloadCb, ' F5 automático após salvar'),
      h('button', { onclick: () => exportBackup().catch(err => alert(tr(err.message))) }, 'Exportar backup'),
      h('button', { onclick: () => toggle(false) }, '✕'));
    ov.replaceChildren(h('div', { class: 'panel' }, hd, h('div', { class: 'tabs' }, els.tabP, els.tabT), els.pView, els.tView, els.toastEl));
  }

  function setLang(code) {
    if (code === LANG) return;
    LANG = code; savePrefs();
    buildShell();
    if (!S.worlds.length) {
      els.right.replaceChildren(h('p', {}, 'Nenhum save encontrado neste navegador. Abra um jogo no Moba GM, carregue o save e tente de novo.'));
      setTab('players', true);
      return;
    }
    fillTeams();
    els.team.value = S.filter.team; els.treg.value = S.tfilter.region;
    setTab(S.tab);
  }

  function setTab(tab, skipRender) {
    S.tab = tab;
    els.pView.style.display = tab === 'players' ? 'flex' : 'none';
    els.tView.style.display = tab === 'teams' ? 'flex' : 'none';
    els.tabP.classList.toggle('active', tab === 'players');
    els.tabT.classList.toggle('active', tab === 'teams');
    if (!skipRender) renderAll();
  }
  function renderAll() {
    if (S.tab === 'players') { renderList(); renderEditor(); } else { renderTeamList(); renderTeamEditor(); }
  }
  let toastTimer;
  function showToast(msg, err, ms = 5000) {
    if (!els.toastEl) return;
    els.toastEl.textContent = msg; els.toastEl.className = 'gtoast' + (err ? ' err' : ''); els.toastEl.style.display = 'block';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { els.toastEl.style.display = 'none'; }, ms);
  }
  async function afterWrite(msg, warnings = []) {
    const w = warnings.length ? ' ' + tr('Atenção: ') + warnings.map(fmtWarn).join(' ') : '';
    const keep = [els.list.scrollTop, els.right.scrollTop, els.tlist.scrollTop, els.tright.scrollTop];
    await loadWorld(S.world);
    renderAll();
    [els.list.scrollTop, els.right.scrollTop, els.tlist.scrollTop, els.tright.scrollTop] = keep;
    showToast(tr(msg) + w + ' ' + (S.autoReload ? tr('Recarregando a página…') : tr('Recarregue (F5) quando quiser que o jogo leia os novos valores.')), warnings.length > 0, S.autoReload ? 3000 : 6000);
    if (S.autoReload) setTimeout(() => location.reload(), warnings.length ? 2500 : 900);
  }
  const takeFlash = () => { const f = S.flash; S.flash = null; return f ? h('div', { class: 'toast' + (f.err ? ' err' : '') }, f.msg) : null; };

  function fillTeams() {
    const teams = [...S.teams.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    els.team.replaceChildren(h('option', { value: '' }, 'Todos os times'), h('option', { value: '__fa' }, 'Sem time (agentes livres)'),
      ...teams.map(t => h('option', { value: String(t.teamId) }, `${t.tag} — ${t.name}`)));
    const regions = [...new Set(teams.map(t => t.region))].sort();
    els.treg.replaceChildren(h('option', { value: '' }, 'Todas as regiões'), ...regions.map(r => h('option', { value: r }, r)));
  }

  // ---------- Aba Jogadores ----------
  function renderList() {
    const { q, team } = S.filter;
    const rows = S.players.filter(p => {
      if (team === '__fa' && S.teams.has(p.teamId)) return false;
      if (team && team !== '__fa' && String(p.teamId) !== team) return false;
      if (!q) return true;
      const t = S.teams.get(p.teamId);
      const hay = `${p.username} ${p.firstName} ${p.lastName} ${t ? t.tag + ' ' + t.name : 'sem time agente livre no team free agent sin equipo agente libre'} ${p.born?.country || ''} ${p.born?.region || ''} ${p.activeRole || ''} ${p.rosterSlot ? slotLabel(p.rosterSlot) : ''}`.toLowerCase();
      return q.split(/\s+/).every(w => hay.includes(w));
    }).slice(0, 250);
    els.list.replaceChildren(...rows.map(p => h('button', {
      class: 'row' + (S.sel === p.playerId ? ' sel' : ''),
      onclick: () => { S.sel = p.playerId; renderList(); renderEditor(); },
    }, `${p.username} — ${p.firstName} ${p.lastName}`,
      h('small', {}, `${teamLabel(p.teamId)}${p.rosterSlot ? ' · ' + slotLabel(p.rosterSlot) : ''} · ${p.activeRole || '—'} · OVR ${p.ovr}/${p.pot}`))));
    if (!rows.length) els.list.replaceChildren(h('p', { class: 'muted', style: 'padding:10px' }, 'Nenhum jogador encontrado.'));
  }

  function gotoPlayer(pid) {
    const p = S.players.find(x => x.playerId === pid);
    S.filter = { q: '', team: p && S.teams.has(p.teamId) ? String(p.teamId) : '' };
    els.q.value = ''; els.team.value = S.filter.team;
    S.sel = pid;
    setTab('players');
  }

  function renderEditor() {
    const p = S.players.find(x => x.playerId === S.sel);
    const flash = takeFlash();
    if (!p) { els.right.replaceChildren(...[flash, h('p', { class: 'muted' }, 'Selecione um jogador à esquerda.')].filter(Boolean)); return; }

    const sk = {}, at = {}, ra = {}, hp = {};
    const ovrIn = numIn(p.ovr), potIn = numIn(p.pot);
    const cVal = h('input', { type: 'number', min: 0, step: 1000, value: p.contract?.value ?? '' });
    const cExp = h('input', { type: 'number', min: 2000, step: 1, value: p.contract?.expires ?? '' });
    const roleSel = h('select', {}, ...ROLES.map(r => h('option', { value: r }, r)));
    roleSel.value = p.activeRole || ROLES[0];
    const toast = h('div');
    const say = (msg, err) => toast.replaceChildren(h('div', { class: 'toast' + (err ? ' err' : '') }, msg));

    // idade e país
    const ps = S.psInfo.get(p.playerId);
    const refYear = ps ? ps.year : S.year;
    const curAge = ps ? ps.age : (p.born?.year != null ? S.year - p.born.year : 20);
    const ageIn = numIn(curAge, 14, 60);
    const countryNames = [...new Set([...S.countries.map(c => c.name), p.born?.country].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const countrySel = h('select', {}, countryNames.map(n => h('option', { value: n }, n)));
    countrySel.value = p.born?.country || countryNames[0];
    const regionNames = [...new Set([...S.countries.flatMap(c => c.region || []), ...[...S.teams.values()].map(t => t.region), p.born?.region].filter(Boolean))].sort();
    const regionSel = h('select', {}, regionNames.map(r => h('option', { value: r }, r)));
    regionSel.value = p.born?.region || regionNames[0];
    countrySel.addEventListener('change', () => {
      const regs = S.countries.find(c => c.name === countrySel.value)?.region || [];
      if (regs.length && !regs.includes(regionSel.value)) regionSel.value = regs[0];
    });

    const skillsGrid = h('div', { class: 'grid' }, SKILLS.map(([k, l]) => { sk[k] = numIn(p.skills?.[k]); return field(l, sk[k]); }));
    const attrsGrid = h('div', { class: 'grid' }, ATTRS.map(([k, l]) => { at[k] = numIn(p.attributes?.[k]); return field(l, at[k]); }));
    const roleGrid = h('div', { class: 'grid' }, ROLES.map(r => { ra[r] = numIn(p.roleAffinities?.[r], 0, 5); return field(r, ra[r]); }));

    const bulkVal = numIn(90);
    const bulk = h('div', { class: 'bar' },
      h('span', {}, 'Todas as skills de jogo ='), bulkVal,
      h('button', { onclick: () => BULK_SKILLS.forEach(k => sk[k].value = num(bulkVal, 90)) }, 'Aplicar'),
      h('button', { onclick: () => BULK_SKILLS.forEach(k => sk[k].value = Math.min(100, num(sk[k], 0) + 5)) }, '+5'),
      h('button', { onclick: () => BULK_SKILLS.forEach(k => sk[k].value = Math.max(0, num(sk[k], 0) - 5)) }, '−5'),
      h('button', { onclick: () => { ovrIn.value = Math.round(BULK_SKILLS.reduce((s, k) => s + num(sk[k], 0), 0) / BULK_SKILLS.length); } }, 'OVR = média das 12 skills'));

    const orig = {};
    const roleNow = p.activeRole || academyRoleOf(S.teams.get(p.teamId), p.playerId) || null;
    const heroFilter = h('input', { type: 'search', placeholder: 'Filtrar heróis do pool…' });
    const heroBox = h('div', { class: 'heroes grid' });
    function addHeroRow(id, v, prepend) {
      const name = S.heroes.get(id) || tf('Herói #{id}', { id });
      const inp = h('input', { type: 'number', min: 0, max: 100, step: 1, value: Math.round(v) });
      hp[id] = inp;
      const row = h('div', { class: 'f' }, h('span', {}, name), h('span', { style: 'display:flex;gap:4px' }, inp,
        h('button', { title: 'Remover do pool', onclick: () => { delete hp[id]; row.remove(); renderResults(); } }, '✕')));
      row.dataset.name = name.toLowerCase();
      if (prepend) heroBox.prepend(row); else heroBox.append(row);
    }
    Object.entries(p.heroPool || {}).sort((x, y) => y[1] - x[1]).forEach(([id, v]) => { orig[id] = v; addHeroRow(id, v, false); });
    heroFilter.addEventListener('input', () => { const q = heroFilter.value.toLowerCase(); [...heroBox.children].forEach(r => r.style.display = r.dataset.name.includes(q) ? '' : 'none'); });
    const heroAll = numIn(100);
    const heroBar = h('div', { class: 'bar' }, heroFilter, h('span', {}, 'Maestria dos heróis visíveis ='), heroAll,
      h('button', { onclick: () => [...heroBox.children].forEach(r => { if (r.style.display !== 'none') r.querySelector('input').value = num(heroAll, 100); }) }, 'Aplicar'));

    // adicionador de heróis
    const addQ = h('input', { type: 'search', placeholder: 'Pesquisar herói por nome ou tipo…' });
    const addVal = numIn(50);
    const addCount = h('span', { class: 'muted' });
    const results = h('div', { class: 'heroes grid' });
    const missingHeroes = () => {
      const q = addQ.value.trim().toLowerCase();
      return S.heroList.filter(x => !(String(x.heroId) in hp) && (!q || x.name.toLowerCase().includes(q) || (x.originalType || '').toLowerCase().includes(q)));
    };
    function renderResults() {
      const list = missingHeroes();
      results.replaceChildren(...(list.length ? list.slice(0, 60).map(x => h('div', { class: 'f' },
        h('span', {}, x.name, h('small', { class: 'muted' }, ` ${x.originalType || ''}${roleNow && x.efficacy ? ` · ${roleNow} ${x.efficacy[roleNow] ?? '?'}/5` : ''}`)),
        h('button', { onclick: () => { addHeroRow(String(x.heroId), num(addVal, 50), true); renderResults(); } }, '+ Adicionar')))
        : [h('span', { class: 'muted' }, 'Nenhum herói encontrado.')]));
      addCount.textContent = tf('{n} herói(s) fora do pool', { n: list.length });
    }
    addQ.addEventListener('input', renderResults);
    const heroAdder = h('div', { class: 'box' },
      h('div', { class: 'bar' }, addQ, h('span', {}, 'Maestria inicial'), addVal,
        h('button', { onclick: () => { missingHeroes().forEach(x => addHeroRow(String(x.heroId), num(addVal, 50), true)); renderResults(); } }, 'Adicionar todos os resultados'), addCount),
      results);
    renderResults();

    const sync = h('input', { type: 'checkbox' }); sync.checked = true;

    async function doSave() {
      try {
        const patch = {
          ovr: num(ovrIn, p.ovr), pot: num(potIn, p.pot), activeRole: p.rosterSlot === 'Active' ? roleSel.value : p.activeRole,
          skills: Object.fromEntries(SKILLS.map(([k]) => [k, num(sk[k], p.skills?.[k] ?? 0)])),
          attributes: Object.fromEntries(ATTRS.map(([k]) => [k, num(at[k], p.attributes?.[k] ?? 0)])),
          roleAffinities: Object.fromEntries(ROLES.map(r => [r, num(ra[r], p.roleAffinities?.[r] ?? 0)])),
          heroPool: Object.fromEntries(Object.entries(hp).map(([id, el]) => [id, (id in orig && String(Math.round(orig[id])) === el.value) ? orig[id] : num(el, 0)])),
          born: { year: num(ageIn, curAge) !== curAge ? refYear - num(ageIn, curAge) : (p.born?.year ?? refYear - curAge), country: countrySel.value, region: regionSel.value },
        };
        if (cVal.value !== '' || cExp.value !== '') patch.contract = { value: num(cVal, p.contract?.value ?? 0), expires: num(cExp, p.contract?.expires ?? 0) };
        await savePlayer(p.playerId, patch, { syncSeason: sync.checked });
        await afterWrite('Salvo!');
      } catch (e) { say(tr('Erro ao salvar: ') + tr(e.message), true); }
    }
    async function doRestore() {
      try {
        await restorePlayer(p.playerId);
        await afterWrite('Valores originais restaurados.');
      } catch (e) { say(tr('Erro: ') + tr(e.message), true); }
    }

    // ---- time e vaga (transferência) ----
    const curTeam = S.teams.get(p.teamId);
    const curAcad = curTeam ? academyRoleOf(curTeam, p.playerId) : null;
    const tTeam = h('select', {}, h('option', { value: '-1' }, 'Agente livre (sem time)'),
      ...[...S.teams.values()].sort(byTag).map(t => h('option', { value: String(t.teamId) }, `${t.tag} — ${t.name}`)));
    tTeam.value = String(S.transferTarget != null ? S.transferTarget : (curTeam ? p.teamId : -1));
    S.transferTarget = null;
    const tSlot = h('select', {}, Object.entries(SLOT_LABEL).map(([v, l]) => h('option', { value: v }, l)));
    tSlot.value = p.rosterSlot && SLOT_LABEL[p.rosterSlot] ? p.rosterSlot : 'Substitute';
    const tRole = h('select', {}, ROLES.map(r => h('option', { value: r }, r)));
    tRole.value = p.activeRole || curAcad || ROLES[0];
    const baseSalary = p.contract?.value ?? p.salaryDemand ?? 0;
    const tSal = h('input', { type: 'number', min: 0, step: 1000, value: baseSalary });
    const tExp = h('input', { type: 'number', min: 2000, step: 1, value: p.contract?.expires ?? (S.year + 1) });
    const tPol = h('select', {},
      h('option', { value: 'bench' }, 'Mandar o ocupante para a reserva'),
      h('option', { value: 'swap' }, 'Trocar de lugar com o ocupante'),
      h('option', { value: 'free' }, 'Mandar o ocupante para agentes livres'));
    const syncT = () => {
      const fa = tTeam.value === '-1';
      tSlot.disabled = fa; tRole.disabled = fa || tSlot.value === 'Substitute';
      tSal.disabled = fa; tExp.disabled = fa; tPol.disabled = fa;
    };
    tTeam.addEventListener('change', syncT);
    tSlot.addEventListener('change', () => { tSal.value = tSlot.value === 'Academy' ? 0 : baseSalary; syncT(); });
    syncT();
    async function doTransfer() {
      try {
        const teamId = parseInt(tTeam.value, 10);
        const { warnings } = await transfer(p.playerId, { teamId, slot: tSlot.value, role: tRole.value, salary: num(tSal, 0), expires: num(tExp, S.year + 1), policy: tPol.value });
        await afterWrite(teamId === -1 ? tf('{u} agora é agente livre.', { u: p.username }) : tf('{u} alocado em {t} ({s}).', { u: p.username, t: teamLabel(teamId), s: slotLabel(tSlot.value) }), warnings);
      } catch (e) { say(tr('Erro ao transferir: ') + tr(e.message), true); }
    }
    const where = curTeam ? `${curTeam.tag} — ${curTeam.name} · ${slotLabel(p.rosterSlot)}${p.activeRole ? ' (' + p.activeRole + ')' : curAcad ? ' (' + curAcad + ')' : ''}` : tr('Agente livre');

    els.right.replaceChildren(...[
      flash,
      h('h2', { style: 'margin:0' }, `${p.username} — ${p.firstName} ${p.lastName}`),
      h('div', { class: 'muted' }, `${where} · ${tf('{c} ({r}) · {a} anos', { c: p.born?.country ?? '?', r: p.born?.region ?? '?', a: curAge })}`),
      h('h3', {}, 'Geral'),
      h('div', { class: 'grid' }, field('OVR', ovrIn), field('POT', potIn),
        field(p.rosterSlot === 'Active' ? 'Role ativa' : 'Role ativa (só titulares)', roleSel),
        field('Salário (contrato)', cVal), field('Contrato expira em', cExp),
        field(tf('Idade (em {y})', { y: refYear }), ageIn), field('País', countrySel), field('Região', regionSel)),
      h('h3', {}, 'Time e vaga'),
      h('div', { class: 'box' },
        h('div', { class: 'grid' }, field('Time', tTeam), field('Vaga', tSlot), field('Role da vaga', tRole),
          field('Salário', tSal), field('Contrato até', tExp), field('Se a vaga estiver ocupada', tPol)),
        h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: doTransfer }, 'Transferir / alocar'),
          h('span', { class: 'muted' }, 'Aplica na hora, separado do botão “Salvar alterações”. Exporte um backup antes.'))),
      h('h3', {}, 'Habilidades'), bulk, skillsGrid,
      h('h3', {}, 'Atributos'), attrsGrid,
      h('h3', {}, 'Afinidade de role (0–5)'), roleGrid,
      h('h3', {}, 'Pool de heróis (maestria)'), heroBar, heroBox,
      h('h3', {}, 'Adicionar heróis ao pool'), heroAdder,
      h('div', { class: 'bar', style: 'margin-top:16px' },
        h('button', { class: 'pri', onclick: doSave }, 'Salvar alterações'),
        h('button', { onclick: doRestore }, 'Restaurar original'),
        h('label', {}, sync, ' sincronizar temporada atual')),
      toast].filter(Boolean));
  }

  // ---------- Aba Times ----------
  function renderTeamList() {
    const { q, region } = S.tfilter;
    const rows = [...S.teams.values()].filter(t => (!region || t.region === region) && (!q || `${t.name} ${t.tag}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.region || '').localeCompare(b.region || '') || (a.leagueDivision || 0) - (b.leagueDivision || 0) || a.name.localeCompare(b.name));
    els.tlist.replaceChildren(...rows.map(t => h('button', {
      class: 'row' + (S.selTeam === t.teamId ? ' sel' : ''),
      onclick: () => { S.selTeam = t.teamId; renderTeamList(); renderTeamEditor(); },
    }, `${t.tag} — ${t.name}`, h('small', {}, tf('{r} · Div {d} · caixa {c}', { r: t.region, d: t.leagueDivision ?? '?', c: money(t.finances?.balance) })))));
    if (!rows.length) els.tlist.replaceChildren(h('p', { class: 'muted', style: 'padding:10px' }, 'Nenhum time encontrado.'));
  }

  function renderTeamEditor() {
    const t = S.teams.get(S.selTeam);
    const flash = takeFlash();
    if (!t) { els.tright.replaceChildren(...[flash, h('p', { class: 'muted' }, 'Selecione um time à esquerda.')].filter(Boolean)); return; }

    const nameIn = h('input', { type: 'text', value: t.name || '' });
    const tagIn = h('input', { type: 'text', value: t.tag || '', maxlength: 6 });
    const logoIn = h('input', { type: 'url', value: t.logoUrl || '' });
    const balIn = h('input', { type: 'number', step: 1000, value: t.finances?.balance ?? 0, style: 'width:130px' });
    const spIn = h('input', { type: 'number', step: 1000, value: t.finances?.sponsorship ?? 0, style: 'width:130px' });
    const trIn = numIn(t.trainingInvestment, 0, 3), acIn = numIn(t.academyInvestment, 0, 3);
    const repIn = numFIn(Math.round((t.reputation ?? 0) * 100) / 100, 0, 100), eloIn = numFIn(Math.round((t.elo ?? 0) * 100) / 100, 1, 100);
    const toast = h('div');
    const say = (msg, err) => toast.replaceChildren(h('div', { class: 'toast' + (err ? ' err' : '') }, msg));

    async function doSaveTeam() {
      try {
        const patch = {
          name: nameIn.value.trim() || t.name, tag: tagIn.value.trim() || t.tag, logoUrl: logoIn.value.trim(),
          finances: { balance: numF(balIn, t.finances?.balance ?? 0), sponsorship: numF(spIn, t.finances?.sponsorship ?? 0) },
          trainingInvestment: num(trIn, t.trainingInvestment ?? 0), academyInvestment: num(acIn, t.academyInvestment ?? 0),
          reputation: numF(repIn, t.reputation ?? 0), elo: numF(eloIn, t.elo ?? 1),
        };
        await saveTeam(t.teamId, patch);
        await afterWrite('Time salvo!');
      } catch (e) { say(tr('Erro ao salvar: ') + tr(e.message), true); }
    }
    async function doRestoreTeam() {
      try { await restoreTeam(t.teamId); await afterWrite('Valores originais do time restaurados.'); }
      catch (e) { say(tr('Erro: ') + tr(e.message), true); }
    }
    async function doRelease(p) {
      if (!confirm(tf('Liberar {u} para agentes livres? O contrato dele será removido.', { u: p.username }))) return;
      try {
        const { warnings } = await transfer(p.playerId, { teamId: -1 });
        await afterWrite(tf('{u} agora é agente livre.', { u: p.username }), warnings);
      } catch (e) { say(tr('Erro: ') + tr(e.message), true); }
    }

    // elenco
    const mine = S.players.filter(p => p.teamId === t.teamId);
    const rowsFor = (slot, list) => list.map(p => {
      const role = slot === 'Academy' ? academyRoleOf(t, p.playerId) : slot === 'Active' ? p.activeRole : '—';
      return h('tr', {}, h('td', {}, SLOT_LABEL[slot]), h('td', {}, role || '—'),
        h('td', {}, `${p.username} — ${p.firstName} ${p.lastName}`), h('td', {}, `${p.ovr}/${p.pot}`),
        h('td', {}, money(p.contract?.value)), h('td', {}, String(p.contract?.expires ?? '—')),
        h('td', {}, h('button', { onclick: () => gotoPlayer(p.playerId) }, 'Editar'), ' ',
          h('button', { class: 'warn', onclick: () => doRelease(p) }, 'Liberar')));
    });
    const active = ROLES.flatMap(r => mine.filter(p => p.rosterSlot === 'Active' && p.activeRole === r));
    const subs = mine.filter(p => p.rosterSlot === 'Substitute');
    const acad = ROLES.flatMap(r => mine.filter(p => p.rosterSlot === 'Academy' && academyRoleOf(t, p.playerId) === r));
    const missing = ROLES.filter(r => !t.roster?.[r]);

    els.tright.replaceChildren(...[
      flash,
      h('h2', { style: 'margin:0' }, `${t.tag} — ${t.name}`),
      h('div', { class: 'muted' }, tf('{r} · Divisão {d}', { r: t.region, d: t.leagueDivision ?? '?' })),
      h('h3', {}, 'Dados do time'),
      h('div', { class: 'grid' }, field('Nome', nameIn), field('Tag', tagIn), field('Logo (URL)', logoIn, 'wide'),
        field('Caixa', balIn), field('Patrocínio', spIn), field('Investimento em treino (0–3)', trIn), field('Investimento na academia (0–3)', acIn),
        field('Reputação (0–100)', repIn), field('Elo (1–100)', eloIn)),
      h('div', { class: 'bar' }, h('button', { class: 'pri', onclick: doSaveTeam }, 'Salvar time'), h('button', { onclick: doRestoreTeam }, 'Restaurar original')),
      h('h3', {}, 'Elenco'),
      missing.length ? h('div', { class: 'toast err' }, tf('Vagas de titular vazias: {l}.', { l: missing.join(', ') })) : null,
      h('table', {}, h('tr', {}, ['Vaga', 'Role', 'Jogador', 'OVR/POT', 'Salário', 'Até', ''].map(x => h('th', {}, x))),
        ...rowsFor('Active', active), ...rowsFor('Substitute', subs), ...rowsFor('Academy', acad)),
      h('div', { class: 'bar', style: 'margin-top:12px' },
        h('button', { onclick: () => { S.transferTarget = t.teamId; S.filter = { q: '', team: '__fa' }; els.q.value = ''; els.team.value = '__fa'; S.sel = null; S.flash = { msg: tf('Escolha um agente livre e use “Time e vaga” para alocá-lo em {t}.', { t: t.tag }), err: false }; setTab('players'); } }, 'Contratar agente livre…'),
        h('span', { class: 'muted' }, 'Para trazer jogador de outro time, abra-o na aba Jogadores e use “Time e vaga”.')),
      toast].filter(Boolean));
  }
})();
