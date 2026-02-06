export function createCondoHandlers(store) {
  function loadData() { return store.load(); }
  function saveData(data) { store.save(data); }

  return {
    'condos.create': ({ params, respond }) => {
      try {
        const { name, description, color } = params;
        if (!name || typeof name !== 'string' || !name.trim()) {
          respond(false, undefined, { message: 'name is required' });
          return;
        }
        const data = loadData();
        const now = Date.now();
        const condo = {
          id: store.newId('condo'),
          name: name.trim(),
          description: typeof description === 'string' ? description : '',
          color: color || null,
          createdAtMs: now,
          updatedAtMs: now,
        };
        data.condos.unshift(condo);
        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.list': ({ params, respond }) => {
      try {
        const data = loadData();
        const condos = data.condos.map(c => ({
          ...c,
          goalCount: data.goals.filter(g => g.condoId === c.id).length,
        }));
        respond(true, { condos });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.get': ({ params, respond }) => {
      try {
        const data = loadData();
        const condo = data.condos.find(c => c.id === params.id);
        if (!condo) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const goals = data.goals.filter(g => g.condoId === condo.id);
        respond(true, { condo, goals });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.update': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.condos.findIndex(c => c.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        const condo = data.condos[idx];

        // Validate name if provided (match condos.create rigor)
        if ('name' in params && (!params.name || typeof params.name !== 'string' || !params.name.trim())) {
          respond(false, undefined, { message: 'name is required' });
          return;
        }

        // Whitelist allowed patch fields (prevent overwriting internal fields)
        const allowed = ['name', 'description', 'color'];
        for (const f of allowed) {
          if (f in params) condo[f] = params[f];
        }
        if (typeof condo.name === 'string') condo.name = condo.name.trim();
        condo.updatedAtMs = Date.now();

        saveData(data);
        respond(true, { condo });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },

    'condos.delete': ({ params, respond }) => {
      try {
        const data = loadData();
        const idx = data.condos.findIndex(c => c.id === params.id);
        if (idx === -1) {
          respond(false, undefined, { message: 'Condo not found' });
          return;
        }
        // Nullify condoId on all linked goals (cascade)
        for (const goal of data.goals) {
          if (goal.condoId === params.id) {
            goal.condoId = null;
          }
        }
        // Clean up sessionCondoIndex entries pointing to this condo
        for (const [key, val] of Object.entries(data.sessionCondoIndex)) {
          if (val === params.id) delete data.sessionCondoIndex[key];
        }
        data.condos.splice(idx, 1);
        saveData(data);
        respond(true, { ok: true });
      } catch (err) {
        respond(false, undefined, { message: String(err) });
      }
    },
  };
}
