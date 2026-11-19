/**
 * Every country, by its English name, for the gift forms' Country dropdown (like Amazon's MCF
 * page: international addresses allowed). The United States comes first. The name is what is
 * stored; the ERP and the Amazon file turn it into the two-letter code.
 */
const CODES =
  "AD AE AF AG AI AL AM AO AR AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");

let cached: string[] | null = null;

/** Country names, "United States" first, then A to Z. */
export function countryNames(): string[] {
  if (cached) return cached;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const all = CODES.filter((code) => code !== "US").map((code) => names.of(code) ?? code);
  cached = ["United States", ...all.sort((a, b) => a.localeCompare(b, "en"))];
  return cached;
}

let byName: Map<string, string> | null = null;

/** The two-letter code for a country name as the dropdown shows it ("Germany" -> "DE"), or null. */
export function countryCodeForName(name: string): string | null {
  if (!byName) {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    byName = new Map(CODES.map((code) => [(names.of(code) ?? code).toLowerCase(), code]));
    // Common other spellings.
    for (const [alias, code] of [["uk", "GB"], ["great britain", "GB"], ["england", "GB"], ["south korea", "KR"], ["russia", "RU"], ["vietnam", "VN"], ["czech republic", "CZ"], ["turkey", "TR"]] as const) byName.set(alias, code);
  }
  return byName.get(name.trim().toLowerCase()) ?? null;
}
