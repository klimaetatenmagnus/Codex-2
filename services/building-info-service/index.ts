// services/building-info-service/index.ts
// ---------------------------------------------------------------------------
// REST-tjeneste: Adresse → Matrikkel → Bygg (+ valgfri Energiattest)
// Oppdatert: juni 2025 (v2.3) – bytter ut SOAP-kallet som gav fault
// ---------------------------------------------------------------------------

import "dotenv/config";
import express, {
  Request,
  Response as ExpressResponse, // ← alias
  type RequestHandler,
} from "express";
import cors from "cors";
import NodeCache from "node-cache";
import fetch, { Response as FetchResponse } from "node-fetch"; // ← alias

import { matrikkelEndpoint } from "../../src/utils/endpoints.ts";
import { MatrikkelClient } from "../../src/clients/MatrikkelClient.ts";
import { BygningClient } from "../../src/clients/BygningClient.ts";
import { StoreClient, ByggInfo } from "../../src/clients/StoreClient.ts";

/* ───────────── Miljøvariabler ───────────── */
const BASE_URL = process.env.MATRIKKEL_API_BASE_URL_TEST!;
const USERNAME = process.env.MATRIKKEL_USERNAME_TEST!;
const PASSWORD = process.env.MATRIKKEL_PASSWORD!;
const ENOVA_KEY = process.env.ENOVA_API_KEY ?? "";
const PORT = Number(process.env.PORT) || 4000;
const LOG = process.env.LOG_SOAP === "1";

/* ───────────── Klient-instanser ─────────── */
const storeClient = new StoreClient(
  matrikkelEndpoint(BASE_URL, "StoreService"),
  USERNAME,
  PASSWORD
);

const bygningClient = new BygningClient(
  matrikkelEndpoint(BASE_URL, "BygningService"),
  USERNAME,
  PASSWORD
);

const matrikkelClient = new MatrikkelClient(
  matrikkelEndpoint(BASE_URL, "MatrikkelenhetService"),
  USERNAME,
  PASSWORD
);

/* cache 24 t */
const cache = new NodeCache({ stdTTL: 86_400, checkperiod: 600 });

/* felles context */
const ctx = () => ({
  locale: "no_NO_B",
  brukOriginaleKoordinater: false,
  koordinatsystemKodeId: 25833,
  systemVersion: "trunk",
  klientIdentifikasjon: "building-info-service",
  snapshotVersion: { timestamp: "9999-01-01T00:00:00+01:00" },
});

/* ───────────── Hoved-flyt ─────────────── */
interface GeoResp {
  adresser: {
    kommunenummer: string;
    gardsnummer: number;
    bruksnummer: number;
    adressekode: number;
    nummer?: string;
    husnummer?: string;
    bokstav?: string;
  }[];
}

async function lookupAdresse(str: string) {
  const headers = { headers: { "User-Agent": "Energitiltak/1.0" } };

  const buildUrl = (s: string) =>
    "https://ws.geonorge.no/adresser/v1/sok?" +
    new URLSearchParams({ sok: s, fuzzy: "true" })
      .toString()
      .replace(/\+/g, "%20");

  const parse = async (r: FetchResponse) => {
    const j = (await r.json()) as GeoResp;
    if (!j.adresser?.length) throw new Error("Adressen ikke funnet i Geonorge");
    const a = j.adresser[0];
    return {
      kommunenummer: a.kommunenummer,
      gnr: a.gardsnummer,
      bnr: a.bruksnummer,
      adressekode: a.adressekode,
      husnummer: Number(a.nummer ?? a.husnummer ?? 0),
      bokstav: a.bokstav ?? "",
    };
  };

  /* ① Prøv original streng */
  const r1 = await fetch(buildUrl(str), headers);
  if (r1.ok) return parse(r1);

  /* ② Fallback-varianter (komma-/whitespace-vask) */
  const variants = [
    str,
    str.replace(/,/g, " ").trim().replace(/\s+/g, " "),
    str
      .replace(/,/g, " ")
      .replace(/(\d+)([A-Za-z])/, "$1 $2")
      .trim()
      .replace(/\s+/g, " "),
  ];

  for (const v of variants) {
    const resp = await fetch(buildUrl(v), headers);
    if (resp.ok) return parse(resp);
  }
  throw new Error("Geonorge gav 400 på alle varianter");
}

/* ───────────── Energiattest (valgfri) ───── */
async function fetchEnergiattest(p: {
  kommunenummer: string;
  gnr: number;
  bnr: number;
}) {
  if (!ENOVA_KEY) return null;

  const r = await fetch(
    "https://api.data.enova.no/ems/offentlige-data/v1/Energiattest",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Energitiltak/1.0",
        "x-api-key": ENOVA_KEY,
      },
      body: JSON.stringify({
        kommunenummer: p.kommunenummer,
        gardsnummer: String(p.gnr),
        bruksnummer: String(p.bnr),
        bruksenhetnummer: "",
        seksjonsnummer: "",
      }),
    }
  );

  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error("Enova " + r.status);
  }
  const list = await r.json();
  return Array.isArray(list) && list[0] ? list[0] : null;
}

export async function resolveBuildingData(adresse: string) {
  /* 1) Geonorge → vegadresse + gnr/bnr */
  const adr = await lookupAdresse(adresse);

  /* 2) kandidat-ID-liste fra findMatrikkelenheter */
  const ids = await matrikkelClient.findMatrikkelenheter(
    {
      kommunenummer: adr.kommunenummer,
      gnr: adr.gnr,
      bnr: adr.bnr,
      adressekode: adr.adressekode,
      husnummer: adr.husnummer,
      bokstav: adr.bokstav,
    },
    ctx()
  );
  if (!ids.length)
    throw new Error("Fant ingen matrikkelenhets-ID for adressen");

  /* 3) Nytt: loop over hver ID og sjekk om den har <hovedadresse>true</hovedadresse> */
  let matrikkelenhetsId: number | undefined;
  for (const id of ids) {
    const xml = await storeClient.getObjectXml(id, "MatrikkelenhetId");

    // fanger <hovedadresse>true</hovedadresse>  **eller**  hovedadresse="true"
    const isMain =
      /<hovedadresse>\s*true\s*<\/hovedadresse>/i.test(xml) ||
      /hovedadresse\s*=\s*["']?true["']?/i.test(xml);

    if (isMain) {
      matrikkelenhetsId = id;
      break;
    }
  }

  // fallback: ta første ID dersom ingen eksplisitt hovedadresse funnet
  if (!matrikkelenhetsId) matrikkelenhetsId = ids[0];
  if (!matrikkelenhetsId) {
    throw new Error(
      "Fant ingen matrikkelenhet hvor <hovedadresse>true</hovedadresse>"
    );
  }

  /* 4) matrikkelenhet → bygg-ID-liste */
  const byggIdListe = await bygningClient.findByggForMatrikkelenhet(
    matrikkelenhetsId,
    ctx()
  );
  if (!byggIdListe.length) {
    throw new Error("Ingen bygg tilknyttet matrikkelenheten");
  }

  /* 5) hent boble for laveste bygg-ID */
  const byggId = Math.min(...byggIdListe);
  const bygg: ByggInfo = await storeClient.getObject(byggId);

  /* 6) representasjonspunkt til PBE-koordinat */
  const rpPBE = bygg.representasjonspunkt?.toPBE();

  /* 7) valgfri energiattest */
  const attest = await fetchEnergiattest({
    kommunenummer: adr.kommunenummer,
    gnr: adr.gnr,
    bnr: adr.bnr,
  });

  /* 8) resultatobjekt */
  return {
    gnr: adr.gnr,
    bnr: adr.bnr,
    matrikkelenhetsId,
    byggId,
    byggeaar: bygg.byggeaar ?? null,
    bruksarealM2: bygg.bruksarealM2 ?? null,
    representasjonspunkt: bygg.representasjonspunkt ?? null,
    representasjonspunktPBE: rpPBE ?? null,
    energiattest: attest,
  } as const;
}

/* ───────────── Express-app (uendret) ────────────── */
/* ... resten av filen er identisk – oppretter /lookup-endepunkt, logger osv ... */

/* ───────────── Express-app ────────────── */
const app = express();
app.use(cors());

const lookupHandler: RequestHandler = async (req, res) => {
  const adresse = req.query.adresse as string | undefined;
  if (!adresse) {
    res.status(400).json({ error: "Mangler adresse" });
    return;
  }

  const key = `lookup:${adresse}`;
  if (cache.has(key)) {
    res.json(cache.get(key));
    return;
  }

  try {
    const data = await resolveBuildingData(adresse);
    cache.set(key, data);
    res.json(data);
  } catch (e: any) {
    console.error(e);
    res.status(500).json({ error: e?.message ?? "Ukjent feil" });
  }
};

app.get("/lookup", lookupHandler);

app.listen(PORT, () =>
  console.log(`✓ building-info-service på http://localhost:${PORT}`)
);
