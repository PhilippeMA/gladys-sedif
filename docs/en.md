# SEDIF water consumption tracking

This integration adds a "SEDIF water meter" device to Gladys, tracking your
drinking water consumption from your customer account on
[leaudiledefrance.fr](https://www.leaudiledefrance.fr/).

SEDIF (Syndicat des Eaux d'Île-de-France) is the public authority in charge of
drinking water for roughly 4 million people around Paris; the service itself is
operated by Veolia under the "L'Eau d'Île-de-France" brand. Your meter readings
are published on that operator's customer portal, which is where this
integration reads them from.

## What you get

The created device carries two measurements, both kept in history so you can
chart them and use them in scenes:

| Measurement           | Unit | Description                                            |
| --------------------- | ---- | ------------------------------------------------------ |
| **Meter index**       | m³   | The total meter reading, the one printed on your bill. |
| **Daily consumption** | L    | The volume used over that day.                         |

## Two ways to get the readings

The **"Where the readings come from"** setting offers two modes. Both produce
exactly the same device and the same charts.

### Automatic (headless browser)

The integration signs in to the customer portal by itself. This is the
comfortable mode: configure it once and forget it.

It has a cost: opening a browser takes a few hundred megabytes of memory and
tens of seconds of CPU per reading. On an already busy machine it does not fit
— on the home server this was first deployed to, Chromium needed **42 seconds
just to start**, before opening a single page. If your readings fail with a
deadline message, switch to the mode below.

### Dropped CSV file

No browser, no credentials: you download the file from the portal yourself,
drop it in the integration's import folder, and it takes care of the rest.

1. On [leaudiledefrance.fr](https://www.leaudiledefrance.fr/), open the
   **Historique** page, pick the **Litres** then **Jours** view, and click
   **Télécharger la période**. You get `historique_jours_litres.csv`.
2. Drop that file into the `/data/import` folder of the integration container:

   ```bash
   # Find the container (its name contains "sedif")
   docker ps --format '{{.Names}}' | grep sedif

   # Copy the file into it
   docker cp historique_jours_litres.csv <container-name>:/data/import/
   ```

3. Click **Test the connection** to check it reads, then **Re-import the
   history** to bring it in right away. Otherwise the next scheduled refresh
   picks it up.

You can drop **several files**: they are all read and merged. A July export
next to an August one simply extends the history. Files are never deleted, and
dropping the same one twice does nothing — the import cursor already knows what
Gladys has.

Choose this mode if your machine is modest, or if you would rather nothing
signed in to your customer account without you.

## Requirements

- An account on [leaudiledefrance.fr](https://www.leaudiledefrance.fr/) with an
  active contract. It is the same account you use to read your bills.
- A remotely-read (télérelevé) meter. SEDIF has rolled these out broadly, but if
  yours is not one of them the portal shows no daily history and the integration
  has nothing to import.
- Check **before installing** that the "Historique" page of your customer
  account does show a daily curve in litres. If it is empty on the website, it
  will be empty in Gladys too.

## Configuration

| Field                          | Purpose                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Email address**              | The login of your customer account.                                                                        |
| **Password**                   | The password of that same account. Encrypted by Gladys, never sent back to your browser.                   |
| **Contract number**            | Only needed if your account holds several contracts (several homes). It is printed on your bill.           |
| **Refresh interval**           | 6 hours by default. The meter is only read once a day, so a shorter interval gains nothing.                |
| **History to import**          | How many days the first import goes back. 30 days by default, up to 3 years.                               |
| **Include estimated readings** | Off by default. See "Measured and estimated readings" below.                                               |
| **History page URL**           | Leave empty. Only useful if the operator moves its history page and the integration can no longer find it. |

Once the fields are filled in, use the **Test the connection** button: it really
signs in to the portal and reports the latest available reading. It is the
fastest way to check your credentials without waiting for the first automatic
poll.

The **Re-import the history** button forgets the import cursor and publishes the
whole configured period again. Use it after changing "History to import", or if
you deleted data in Gladys.

## Data delay

Readings are not real time. The meter is read remotely once a day and the
operator publishes the value with a **one to two day delay**: the device shows
the day before yesterday's consumption, not the current minute. That is a limit
of the service, not of the integration.

Every reading is published in Gladys **at its actual date**, not at the date of
the import: your consumption chart is correctly dated, including the history
picked up on the very first run.

The integration paces its own refresh instead of using the Gladys polling
mechanism, which never goes slower than once a minute — far too fast for a
daily value that costs a browser session to fetch. A first refresh runs about
fifteen seconds after startup and after every configuration change, then at the
interval you chose.

## Measured and estimated readings

For each day the portal states whether the value was **measured** or
**estimated**. An estimate fills a gap between two real readings, and the
resulting index can go backwards once the real measurement lands — which
produces inconsistent charts and breaks any consumption arithmetic.

The integration therefore skips estimated readings by default: a day without a
real measurement is simply missing from the chart, and shows up later if the
operator publishes the real value. The "Include estimated readings" option is
there if you would rather have a continuous chart than an exact one.

## How the data is retrieved

Neither SEDIF nor its operator publishes an API for consumption data. The
customer portal is a Salesforce site whose exchanges are signed and change with
every release of the site.

So this integration does what you would do by hand: it opens a headless browser
(Chromium), signs in with your credentials, opens the "Historique" page, selects
the daily view in litres, and reads the CSV produced by the download button. The
file is never written to disk — it is read straight out of the page.

**A consequence worth knowing:** this approach depends on the structure of the
website's pages. If the operator redesigns the portal, the integration can stop
working overnight until it is updated. The device badge then turns orange, and
the integration logs (`docker logs`) name the step that failed.

## Your credentials

Your credentials never leave your Gladys installation. They are stored encrypted
by Gladys, passed to the integration running in its own container on your own
hardware, and used only to sign in to `connexion.leaudiledefrance.fr`. No third
party service is contacted.

## Troubleshooting

- **"Test the connection" reports refused credentials**: check them by signing
  in by hand on the website. An account can also be temporarily locked after
  several failed attempts.
- **No data after several hours**: open the "Historique" page of your customer
  account. If it shows no daily curve, your meter is most likely not remotely
  read.
- **The device badge is orange**: either the last import failed, or the operator
  has published nothing for more than four days. The badge tooltip gives the
  reason.
- **The chart stops at a past date**: that is the expected behaviour when the
  operator stops publishing; the missing days are imported as soon as they show
  up on the website.
- **"Cannot reach connexion.leaudiledefrance.fr"**: the message names the
  exact cause — DNS resolution, refused connection, or no answer at all. The
  integration only ever checks raw network reach, never the certificate: the
  portal serves an incomplete chain that browsers repair by themselves, and a
  check stricter than the browser would reject a perfectly healthy setup.
- **"The action failed. Check that the integration is started."**: Gladys gives
  a button 120 seconds at most to answer. The integration gives up before that
  to send you a real explanation, so if you still get this generic message the
  container has stopped answering entirely — check its logs.

## Machine load

Opening a browser is expensive: a few hundred megabytes of memory and tens of
seconds of CPU per reading. That is why the default interval is 6 hours and the
minimum is one hour.

The integration never opens two browsers at once: click a button while a
scheduled reading is running and the second one refuses to start and says so.
Each session also has a hard time limit after which the browser is killed, so a
stuck page cannot leave a Chromium running forever.

If your machine stays loaded while the integration is installed, stop it from
Gladys: the load should drop immediately. If it does not, it comes from
something else — building the Docker image, for one, is far heavier than
running it.
