// -----------------------------------------------------------------------------
// A stand-in for the customer portal, served over plain HTTP.
//
// It is NOT a replica of the real site: it is a page carrying the same handful
// of hooks the driver actually depends on — the email/password inputs, the
// submit button, the profile icon that proves a session, the Litres/Jours
// toggles, the "Telecharger la periode" button and, above all, the hidden
// `<a download>` whose href is a `data:` URI.
//
// It exists so that the browser plumbing (fill, click, wait, read attribute)
// is exercised for real, without credentials and without the SEDIF.
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';

const HEAD = '<!doctype html><html lang="fr"><head><meta charset="utf-8"></head><body>';
const FOOT = '</body></html>';

const LOGIN_PAGE = `${HEAD}
<form>
  <input inputmode="email" type="text" name="username" />
  <input type="password" name="password" />
  <button class="submit-button" type="submit">Se connecter</button>
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const email = document.querySelector('input[inputmode="email"]').value;
    const password = document.querySelector('input[type="password"]').value;
    location.href = '/s/?email=' + encodeURIComponent(email) +
      '&password=' + encodeURIComponent(password);
  });
</script>
${FOOT}`;

const LOGIN_ERROR_PAGE = `${HEAD}
<form>
  <input inputmode="email" type="text" name="username" />
  <input type="password" name="password" />
  <button class="submit-button" type="submit">Se connecter</button>
</form>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const banner = document.createElement('div');
    banner.setAttribute('role', 'alert');
    banner.textContent = 'Votre identifiant ou votre mot de passe est incorrect.';
    document.body.appendChild(banner);
  });
</script>
${FOOT}`;

const dashboardPage = (query) => `${HEAD}
<div class="profileIcon">PM</div>
<p>Connecte: ${query.get('email') ?? ''}</p>
<a href="/s/historique">Historique</a>
${FOOT}`;

const historyPage = (csv, contract) => `${HEAD}
<div class="profileIcon">PM</div>
${contract ? `<a href="/s/historique?contract=${contract}">${contract}</a>` : ''}
<span>Litres</span>
<span>Jours</span>
<button type="button" id="download">Télécharger la période</button>
<div id="slot"></div>
<script>
  const csv = ${JSON.stringify(csv)};
  document.getElementById('download').addEventListener('click', () => {
    const link = document.createElement('a');
    link.setAttribute('download', 'historique_jours_litres.csv');
    link.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    link.textContent = 'csv';
    document.getElementById('slot').appendChild(link);
  });
</script>
${FOOT}`;

/**
 * Start the stand-in portal.
 *
 * @param {object} options
 * @param {string} options.csv         content the export button will produce
 * @param {boolean} [options.rejectLogin] serve the "wrong password" variant
 * @param {string} [options.contract]  render a contract link on the history page
 * @returns {Promise<{ loginUrl: string, historyUrl: string, close: () => Promise<void> }>}
 */
export async function startFakePortal({ csv, rejectLogin = false, contract = '' }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');

    if (url.pathname === '/s/login/') {
      res.end(rejectLogin ? LOGIN_ERROR_PAGE : LOGIN_PAGE);
      return;
    }
    if (url.pathname === '/s/historique') {
      res.end(historyPage(csv, contract));
      return;
    }
    if (url.pathname === '/s/' || url.pathname === '/s') {
      res.end(dashboardPage(url.searchParams));
      return;
    }
    res.statusCode = 404;
    res.end(`${HEAD}not found${FOOT}`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    loginUrl: `http://127.0.0.1:${port}/s/login/`,
    historyUrl: `http://127.0.0.1:${port}/s/historique`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
