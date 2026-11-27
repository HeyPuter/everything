import { createClient } from '../storage/client.js';

const SESSION_KEY = 'cloud-studio.session.v1';

export function mount(root) {
  const client = createClient();
  const state = {
    view: 'overview',
    flash: null,
    buckets: [],
    selectedBucket: null,
    objects: [],
    functions: [],
    selectedFn: null,
    fnSource: defaultHandlerSource(),
    logs: [],
    keys: [],
  };

  async function boot() {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (saved?.accessKeyId && saved?.secretAccessKey) {
        await client.signIn(saved.accessKeyId, saved.secretAccessKey);
      } else {
        const admin = await client.bootstrap();
        await client.signIn(admin.accessKeyId, admin.secretAccessKey);
        localStorage.setItem(SESSION_KEY, JSON.stringify(admin));
        state.flash = {
          kind: 'ok',
          text: `Bootstrap admin key created: ${admin.accessKeyId} (secret shown once in console)`,
        };
        console.info('[Cloud Studio] bootstrap secretAccessKey:', admin.secretAccessKey);
      }
    } catch (err) {
      state.flash = { kind: 'err', text: err.message };
    }
    await refresh();
    render();
  }

  async function refresh() {
    if (!client.signedIn) return;
    try {
      state.buckets = await client.listBuckets();
      state.keys = await client.listKeys();
      state.functions = await client.listFunctions();
      if (state.selectedBucket) {
        const listed = await client.listObjects(state.selectedBucket);
        state.objects = listed.contents;
      }
      if (state.selectedFn) {
        const fn = await client.getFunction(state.selectedFn);
        state.fnSource = fn.source;
        state.logs = await client.listLogs(state.selectedFn);
      }
    } catch (err) {
      state.flash = { kind: 'err', text: err.message };
    }
  }

  function render() {
    root.innerHTML = '';
    root.append(el('header', { class: 'topbar' }, [
      el('div', { class: 'brand' }, ['Cloud ', el('span', {}, ['Studio'])]),
      el('div', { class: 'spacer' }),
      el('div', { class: 'identity' }, [
        client.identity
          ? `signed in · ${client.identity.accessKeyId}`
          : 'signed out',
      ]),
    ]));

    const shell = el('div', { class: 'shell' });
    const nav = el('nav', { class: 'side' });
    for (const [id, label] of [
      ['overview', 'Overview'],
      ['storage', 'Object storage'],
      ['functions', 'Functions'],
      ['keys', 'Access keys'],
    ]) {
      nav.append(
        el('button', {
          class: state.view === id ? 'active' : '',
          type: 'button',
          onclick: async () => {
            state.view = id;
            await refresh();
            render();
          },
        }, [label]),
      );
    }
    shell.append(nav);

    const main = el('main', { class: 'panel' });
    if (state.flash) {
      main.append(el('div', { class: `flash ${state.flash.kind}` }, [state.flash.text]));
    }
    if (state.view === 'overview') main.append(viewOverview());
    if (state.view === 'storage') main.append(viewStorage());
    if (state.view === 'functions') main.append(viewFunctions());
    if (state.view === 'keys') main.append(viewKeys());
    shell.append(main);
    root.append(shell);
  }

  function viewOverview() {
    return el('div', {}, [
      el('h1', {}, ['Local cloud primitives']),
      el('p', { class: 'lead' }, [
        'Cloud Studio runs object storage and a constrained function runtime in this browser. ',
        'Every console action calls a real service method — nothing is simulated success. ',
        'This is not AWS-compatible end-to-end; APIs are intentionally small and documented in the README.',
      ]),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('h2', {}, ['Object storage']),
          el('p', { class: 'muted' }, [`${state.buckets.length} bucket(s)`]),
          el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => {
              state.view = 'storage';
              render();
            },
          }, ['Open storage']),
        ]),
        el('div', { class: 'card' }, [
          el('h2', {}, ['Functions']),
          el('p', { class: 'muted' }, [`${state.functions.length} function(s)`]),
          el('button', {
            class: 'primary',
            type: 'button',
            onclick: () => {
              state.view = 'functions';
              render();
            },
          }, ['Open functions']),
        ]),
      ]),
    ]);
  }

  function viewStorage() {
    const wrap = el('div', {}, [
      el('h1', {}, ['Object storage']),
      el('p', { class: 'lead' }, [
        'S3-inspired buckets and objects persisted in IndexedDB. Max object size 16 MiB in v0.',
      ]),
    ]);

    const createRow = el('div', { class: 'card' }, [
      el('h2', {}, ['Buckets']),
      el('div', { class: 'row' }, [
        (() => {
          const input = el('input', {
            placeholder: 'bucket-name',
            id: 'bucket-name',
          });
          return input;
        })(),
        el('button', {
          class: 'primary',
          type: 'button',
          onclick: async () => {
            const name = root.querySelector('#bucket-name').value.trim();
            try {
              await client.createBucket(name);
              state.flash = { kind: 'ok', text: `Created bucket ${name}` };
              state.selectedBucket = name;
              await refresh();
            } catch (err) {
              state.flash = { kind: 'err', text: err.message };
            }
            render();
          },
        }, ['Create']),
      ]),
      bucketTable(),
    ]);
    wrap.append(createRow);

    if (state.selectedBucket) {
      wrap.append(objectPanel(state.selectedBucket));
    } else {
      wrap.append(el('div', { class: 'empty' }, ['Select a bucket to list and upload objects.']));
    }
    return wrap;
  }

  function bucketTable() {
    if (!state.buckets.length) return el('div', { class: 'empty' }, ['No buckets yet.']);
    const table = el('table', {}, [
      el('thead', {}, [el('tr', {}, [el('th', {}, ['Name']), el('th', {}, ['Created']), el('th', {}, [''])])]),
    ]);
    const body = el('tbody');
    for (const b of state.buckets) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'mono' }, [b.name]),
          el('td', { class: 'muted' }, [b.createdAt?.slice(0, 19) || '']),
          el('td', {}, [
            el('div', { class: 'list-actions' }, [
              el('button', {
                type: 'button',
                onclick: async () => {
                  state.selectedBucket = b.name;
                  await refresh();
                  render();
                },
              }, ['Open']),
              el('button', {
                type: 'button',
                onclick: async () => {
                  try {
                    await client.deleteBucket(b.name);
                    if (state.selectedBucket === b.name) {
                      state.selectedBucket = null;
                      state.objects = [];
                    }
                    state.flash = { kind: 'ok', text: `Deleted ${b.name}` };
                    await refresh();
                  } catch (err) {
                    state.flash = { kind: 'err', text: err.message };
                  }
                  render();
                },
              }, ['Delete']),
            ]),
          ]),
        ]),
      );
    }
    table.append(body);
    return table;
  }

  function objectPanel(bucket) {
    const fileInput = el('input', { type: 'file', id: 'obj-file' });
    const keyInput = el('input', { placeholder: 'object key (optional)', id: 'obj-key' });
    return el('div', { class: 'card' }, [
      el('h2', {}, [`Objects in ${bucket}`]),
      el('div', { class: 'row' }, [
        fileInput,
        keyInput,
        el('button', {
          class: 'primary',
          type: 'button',
          onclick: async () => {
            const file = fileInput.files?.[0];
            if (!file) {
              state.flash = { kind: 'err', text: 'Choose a file first' };
              render();
              return;
            }
            const objectKey = keyInput.value.trim() || file.name;
            try {
              const buf = new Uint8Array(await file.arrayBuffer());
              const meta = await client.putObject(bucket, objectKey, buf, {
                contentType: file.type || 'application/octet-stream',
              });
              state.flash = { kind: 'ok', text: `Uploaded ${meta.key} (${meta.size} bytes)` };
              await refresh();
            } catch (err) {
              state.flash = { kind: 'err', text: err.message };
            }
            render();
          },
        }, ['Upload']),
      ]),
      objectTable(bucket),
    ]);
  }

  function objectTable(bucket) {
    if (!state.objects.length) return el('div', { class: 'empty' }, ['Bucket is empty.']);
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['Key']),
          el('th', {}, ['Size']),
          el('th', {}, ['Type']),
          el('th', {}, ['']),
        ]),
      ]),
    ]);
    const body = el('tbody');
    for (const o of state.objects) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'mono' }, [o.key]),
          el('td', {}, [String(o.size)]),
          el('td', { class: 'muted' }, [o.contentType || '']),
          el('td', {}, [
            el('div', { class: 'list-actions' }, [
              el('button', {
                type: 'button',
                onclick: async () => {
                  try {
                    const obj = await client.getObject(bucket, o.key);
                    downloadBytes(obj.key, obj.body, obj.contentType);
                  } catch (err) {
                    state.flash = { kind: 'err', text: err.message };
                    render();
                  }
                },
              }, ['Download']),
              el('button', {
                type: 'button',
                onclick: async () => {
                  try {
                    await client.deleteObject(bucket, o.key);
                    state.flash = { kind: 'ok', text: `Deleted ${o.key}` };
                    await refresh();
                  } catch (err) {
                    state.flash = { kind: 'err', text: err.message };
                  }
                  render();
                },
              }, ['Delete']),
            ]),
          ]),
        ]),
      );
    }
    table.append(body);
    return table;
  }

  function viewFunctions() {
    const nameInput = el('input', { id: 'fn-name', placeholder: 'function-name', value: state.selectedFn || '' });
    const source = el('textarea', { id: 'fn-source' }, [state.fnSource]);
    const eventInput = el('textarea', { id: 'fn-event' }, ['{\n  "name": "world"\n}']);
    return el('div', {}, [
      el('h1', {}, ['Functions']),
      el('p', { class: 'lead' }, [
        'Experimental local runtime with timeouts and logs. Not a multi-tenant secure isolator — for demos and tests only.',
      ]),
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('h2', {}, ['Deploy']),
          el('div', { class: 'row' }, [nameInput]),
          source,
          el('div', { class: 'row' }, [
            el('button', {
              class: 'primary',
              type: 'button',
              onclick: async () => {
                const name = nameInput.value.trim();
                try {
                  await client.putFunction(name, source.value, { timeoutMs: 3000 });
                  state.selectedFn = name;
                  state.flash = { kind: 'ok', text: `Deployed ${name}` };
                  await refresh();
                } catch (err) {
                  state.flash = { kind: 'err', text: err.message };
                }
                render();
              },
            }, ['Save & deploy']),
            el('button', {
              type: 'button',
              onclick: async () => {
                const name = nameInput.value.trim();
                try {
                  const event = JSON.parse(eventInput.value || '{}');
                  const out = await client.invokeFunction(name, event);
                  state.flash = {
                    kind: 'ok',
                    text: `Invoke ok (${out.durationMs}ms): ${JSON.stringify(out.payload)}`,
                  };
                  state.selectedFn = name;
                  await refresh();
                } catch (err) {
                  state.flash = { kind: 'err', text: err.message };
                  await refresh();
                }
                render();
              },
            }, ['Invoke']),
          ]),
          el('h2', {}, ['Event JSON']),
          eventInput,
        ]),
        el('div', { class: 'card' }, [
          el('h2', {}, ['Deployed']),
          functionList(),
          el('h2', {}, ['Recent logs']),
          logList(),
        ]),
      ]),
    ]);
  }

  function functionList() {
    if (!state.functions.length) return el('div', { class: 'empty' }, ['No functions yet.']);
    const table = el('table');
    const body = el('tbody');
    for (const fn of state.functions) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'mono' }, [fn.name]),
          el('td', { class: 'muted' }, [`${fn.timeoutMs}ms`]),
          el('td', {}, [
            el('div', { class: 'list-actions' }, [
              el('button', {
                type: 'button',
                onclick: async () => {
                  state.selectedFn = fn.name;
                  await refresh();
                  render();
                },
              }, ['Edit']),
              el('button', {
                type: 'button',
                onclick: async () => {
                  try {
                    await client.deleteFunction(fn.name);
                    if (state.selectedFn === fn.name) state.selectedFn = null;
                    state.flash = { kind: 'ok', text: `Deleted ${fn.name}` };
                    await refresh();
                  } catch (err) {
                    state.flash = { kind: 'err', text: err.message };
                  }
                  render();
                },
              }, ['Delete']),
            ]),
          ]),
        ]),
      );
    }
    table.append(body);
    return table;
  }

  function logList() {
    if (!state.logs.length) return el('div', { class: 'empty' }, ['No logs for this function.']);
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['When']),
          el('th', {}, ['Status']),
          el('th', {}, ['ms']),
          el('th', {}, ['Error']),
        ]),
      ]),
    ]);
    const body = el('tbody');
    for (const log of state.logs) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'muted' }, [(log.at || '').slice(0, 19)]),
          el('td', {}, [log.status]),
          el('td', {}, [String(log.durationMs ?? '')]),
          el('td', { class: 'mono' }, [log.error?.message || '']),
        ]),
      );
    }
    table.append(body);
    return table;
  }

  function viewKeys() {
    return el('div', {}, [
      el('h1', {}, ['Access keys']),
      el('p', { class: 'lead' }, [
        'Local keys with permission strings. Secrets are only shown at creation time.',
      ]),
      el('div', { class: 'card' }, [
        el('button', {
          class: 'primary',
          type: 'button',
          onclick: async () => {
            try {
              const key = await client.createKey({ label: 'console' });
              state.flash = {
                kind: 'ok',
                text: `Created ${key.accessKeyId} — secret: ${key.secretAccessKey}`,
              };
              await refresh();
            } catch (err) {
              state.flash = { kind: 'err', text: err.message };
            }
            render();
          },
        }, ['Create key']),
        keysTable(),
      ]),
    ]);
  }

  function keysTable() {
    if (!state.keys.length) return el('div', { class: 'empty' }, ['No keys.']);
    const table = el('table', {}, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['Access key']),
          el('th', {}, ['Label']),
          el('th', {}, ['Permissions']),
        ]),
      ]),
    ]);
    const body = el('tbody');
    for (const k of state.keys) {
      body.append(
        el('tr', {}, [
          el('td', { class: 'mono' }, [k.accessKeyId]),
          el('td', {}, [k.label || '']),
          el('td', { class: 'mono muted' }, [(k.permissions || []).join(', ')]),
        ]),
      );
    }
    table.append(body);
    return table;
  }

  boot();
  return { client, refresh };
}

function defaultHandlerSource() {
  return `exports.handler = async (event) => {
  return { hello: event?.name || 'cloud-studio', at: new Date().toISOString() };
};
`;
}

function downloadBytes(name, bytes, type) {
  const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.split('/').pop() || 'download';
  a.click();
  URL.revokeObjectURL(url);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'onclick') node.addEventListener('click', v);
    else if (k === 'class') node.className = v;
    else if (v != null) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
