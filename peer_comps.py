"""Sell-side-style comparable company selection.

Morgan Stanley / Goldman / BofA (Merrill) comps desks pick peers by:
  1. Business model / GICS sub-industry (not broad sector)
  2. Market-cap / revenue proximity (same size bucket)
  3. Geography and listing quality (US large/mid liquid names)

This module is the shared source of truth for:
  • Research-report verified peer blocks (claude_analyst)
  • Financials dashboard peer comps + rank-card industry peers (api/server)
"""
from __future__ import annotations

import re
from typing import Iterable


# ── Curated industry peer groups (US liquid names, sell-side style) ──────────
# Each group: match any of `keywords` (case-insensitive substring on industry
# string). Higher `priority` wins when multiple groups match. `exclude` kills a
# match if those substrings appear (e.g. semi equipment ≠ chip designers).
_INDUSTRY_GROUPS: list[dict] = [
    # ── Technology ──────────────────────────────────────────────────────────
    {
        "id": "semiconductors",
        "priority": 100,
        "keywords": [
            "semiconductor", "semiconductors", "chip", "chips",
            "integrated circuit", "microprocessor", "memory",
        ],
        "exclude": ["equipment", "material", "materials", "equipment & materials"],
        "peers": [
            "NVDA", "AMD", "AVGO", "TXN", "QCOM", "MU", "INTC", "ADI", "MRVL",
            "ON", "NXPI", "MCHP", "SWKS", "QRVO", "MPWR", "LSCC", "WOLF", "CRUS",
        ],
    },
    {
        "id": "semi_equipment",
        "priority": 110,
        "keywords": [
            "semiconductor equipment", "semiconductor materials",
            "semiconductor equipment & materials", "wafer",
        ],
        "exclude": [],
        "peers": [
            "ASML", "AMAT", "LRCX", "KLAC", "TER", "ENTG", "AMKR", "ACLS",
            "ONTO", "CAMT", "UCTT", "FORM",
        ],
    },
    {
        "id": "software_application",
        "priority": 90,
        "keywords": [
            "software—application", "software - application", "application software",
            "software application", "saas",
        ],
        "exclude": ["infrastructure", "systems software"],
        "peers": [
            "CRM", "ADBE", "NOW", "INTU", "WDAY", "TEAM", "SNOW", "DDOG", "ZS",
            "CRWD", "PANW", "FTNT", "OKTA", "MDB", "NET", "HUBS", "VEEV", "ANSS",
            "ADSK", "CDNS", "SNPS", "TYL", "PAYC", "PCTY",
        ],
    },
    {
        "id": "software_infrastructure",
        "priority": 95,
        "keywords": [
            "software—infrastructure", "software - infrastructure",
            "infrastructure software", "systems software", "cybersecurity",
            "security software",
        ],
        "exclude": [],
        "peers": [
            "MSFT", "ORCL", "IBM", "PANW", "CRWD", "FTNT", "ZS", "OKTA", "S",
            "NET", "DDOG", "SNOW", "PLTR", "GEN", "RPD",
        ],
    },
    {
        "id": "it_services",
        "priority": 85,
        "keywords": [
            "information technology services", "it services", "consulting services",
            "data processing",
        ],
        "exclude": [],
        "peers": ["ACN", "IBM", "CTSH", "INFY", "WIT", "EPAM", "IT", "CDW", "LDOS", "SAIC"],
    },
    {
        "id": "internet_content",
        "priority": 90,
        "keywords": [
            "internet content", "internet content & information",
            "interactive media", "online media",
        ],
        "exclude": [],
        "peers": ["GOOGL", "META", "SNAP", "PINS", "RDDT", "MTCH", "IAC", "YELP", "ZG"],
    },
    {
        "id": "consumer_electronics",
        "priority": 90,
        "keywords": ["consumer electronics", "computer hardware", "computer manufacturers"],
        "exclude": [],
        "peers": ["AAPL", "SONY", "HPQ", "DELL", "HPE", "NTAP", "WDC", "STX", "SMCI"],
    },
    {
        "id": "communication_equipment",
        "priority": 90,
        "keywords": ["communication equipment", "telecom equipment", "networking equipment"],
        "exclude": [],
        "peers": ["CSCO", "ANET", "JNPR", "CIEN", "FFIV", "MSI", "NOK", "ERIC", "HPE"],
    },
    {
        "id": "electronic_components",
        "priority": 85,
        "keywords": ["electronic components", "electronic manufacturing", "ems"],
        "exclude": ["semiconductor"],
        "peers": ["TEL", "APH", "GLW", "FLEX", "JBL", "SANM", "CLS", "TTMI"],
    },
    # ── Communication Services ──────────────────────────────────────────────
    {
        "id": "telecom_wireless",
        "priority": 90,
        "keywords": ["telecom services", "wireless", "communication services"],
        "exclude": ["media", "entertainment", "interactive"],
        "peers": ["TMUS", "VZ", "T", "CHTR", "CMCSA", "LUMN", "FYBR"],
    },
    {
        "id": "media_entertainment",
        "priority": 90,
        "keywords": [
            "entertainment", "broadcasting", "cable", "media", "movies",
            "publishing", "advertising agencies",
        ],
        "exclude": ["interactive media", "internet content"],
        "peers": ["DIS", "NFLX", "WBD", "PARA", "CMCSA", "FOX", "FOXA", "LYV", "SPOT", "ROKU"],
    },
    {
        "id": "gaming",
        "priority": 95,
        "keywords": ["electronic gaming", "gaming", "video game"],
        "exclude": [],
        "peers": ["EA", "TTWO", "RBLX", "U", "ZNGA", "PLTK"],
    },
    # ── Consumer ────────────────────────────────────────────────────────────
    {
        "id": "internet_retail",
        "priority": 95,
        "keywords": ["internet retail", "e-commerce", "online retail"],
        "exclude": [],
        "peers": ["AMZN", "EBAY", "ETSY", "W", "CHWY", "BABA", "MELI", "SE", "CPNG"],
    },
    {
        "id": "auto_manufacturers",
        "priority": 95,
        "keywords": ["auto manufacturers", "automobiles", "auto makers"],
        "exclude": ["parts", "components", "dealership"],
        "peers": ["TSLA", "F", "GM", "RIVN", "LCID", "STLA", "TM", "HMC"],
    },
    {
        "id": "auto_parts",
        "priority": 90,
        "keywords": ["auto parts", "auto components", "auto & truck dealerships"],
        "exclude": [],
        "peers": ["APTV", "BWA", "LEA", "MGA", "ALV", "GNTX", "DORM", "AXL", "KMX", "AN", "PAG"],
    },
    {
        "id": "restaurants",
        "priority": 95,
        "keywords": ["restaurants", "restaurant"],
        "exclude": [],
        "peers": ["MCD", "SBUX", "CMG", "YUM", "QSR", "DPZ", "WING", "TXRH", "SHAK", "CAKE", "DRI"],
    },
    {
        "id": "apparel_retail",
        "priority": 90,
        "keywords": [
            "apparel retail", "apparel manufacturing", "footwear", "luxury goods",
            "specialty retail",
        ],
        "exclude": ["home improvement", "electronics"],
        "peers": ["NKE", "LULU", "TJX", "ROST", "GPS", "ANF", "AEO", "URBN", "DECK", "CROX", "SKX", "VFC", "RL", "TPR", "CPRI"],
    },
    {
        "id": "home_improvement",
        "priority": 95,
        "keywords": ["home improvement", "home improvement retail"],
        "exclude": [],
        "peers": ["HD", "LOW", "FND", "TSCO", "WSM", "RH"],
    },
    {
        "id": "hotels_travel",
        "priority": 90,
        "keywords": [
            "lodging", "hotels", "resorts", "travel services", "travel agencies",
            "airlines", "airports",
        ],
        "exclude": [],
        "peers": ["MAR", "HLT", "H", "IHG", "WH", "ABNB", "BKNG", "EXPE", "TRIP", "DAL", "UAL", "AAL", "LUV", "ALK"],
    },
    {
        "id": "food_beverage",
        "priority": 90,
        "keywords": [
            "packaged foods", "beverages", "soft drinks", "confectioners",
            "food products", "brewer", "distiller",
        ],
        "exclude": [],
        "peers": ["KO", "PEP", "MNST", "KDP", "STZ", "BUD", "MDLZ", "GIS", "KHC", "K", "CPB", "SJM", "HSY", "CAG"],
    },
    {
        "id": "household_personal",
        "priority": 90,
        "keywords": [
            "household products", "personal products", "household & personal",
        ],
        "exclude": [],
        "peers": ["PG", "CL", "KMB", "CHD", "CLX", "EL", "COTY", "UL"],
    },
    {
        "id": "tobacco",
        "priority": 100,
        "keywords": ["tobacco", "smoke"],
        "exclude": [],
        "peers": ["PM", "MO", "BTI", "UVV"],
    },
    {
        "id": "discount_stores",
        "priority": 95,
        "keywords": ["discount stores", "hypermarkets", "grocery stores"],
        "exclude": [],
        "peers": ["WMT", "COST", "TGT", "DG", "DLTR", "BJ", "KR", "SFM"],
    },
    # ── Financials ──────────────────────────────────────────────────────────
    {
        "id": "banks_money_center",
        "priority": 95,
        "keywords": [
            "banks—diversified", "banks - diversified", "money center",
            "diversified banks",
        ],
        "exclude": ["regional", "thrifts"],
        "peers": ["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC", "COF", "BK", "STT"],
    },
    {
        "id": "banks_regional",
        "priority": 95,
        "keywords": ["banks—regional", "banks - regional", "regional banks", "thrifts"],
        "exclude": [],
        "peers": [
            "USB", "PNC", "TFC", "CFG", "KEY", "RF", "FITB", "HBAN", "MTB", "ZION",
            "CMA", "SIVB", "WAL", "EWBC", "FHN",
        ],
    },
    {
        "id": "investment_banking",
        "priority": 100,
        "keywords": [
            "capital markets", "investment banking", "asset management",
            "financial data", "financial exchanges",
        ],
        "exclude": ["insurance", "bank"],
        "peers": ["GS", "MS", "SCHW", "BLK", "BX", "KKR", "APO", "ARES", "TROW", "BEN", "IVZ", "SPGI", "MCO", "MSCI", "ICE", "CME", "NDAQ"],
    },
    {
        "id": "payments",
        "priority": 100,
        "keywords": [
            "credit services", "payment", "transaction processing",
            "financial technology",
        ],
        "exclude": [],
        "peers": ["V", "MA", "AXP", "PYPL", "SQ", "AFRM", "FIS", "FISV", "GPN", "WEX", "FLT"],
    },
    {
        "id": "insurance_life",
        "priority": 90,
        "keywords": ["insurance—life", "insurance - life", "life insurance"],
        "exclude": [],
        "peers": ["MET", "PRU", "AIG", "AFL", "LNC", "VOYA", "GL", "UNM"],
    },
    {
        "id": "insurance_pnc",
        "priority": 90,
        "keywords": [
            "insurance—property", "insurance - property", "property & casualty",
            "insurance brokers", "insurance—specialty",
        ],
        "exclude": ["life"],
        "peers": ["PGR", "TRV", "ALL", "CB", "AIG", "HIG", "CINF", "WRB", "ACGL", "AJG", "AON", "MMC", "BRO"],
    },
    # ── Healthcare ──────────────────────────────────────────────────────────
    {
        "id": "biotech",
        "priority": 100,
        "keywords": ["biotechnology", "biotech"],
        "exclude": [],
        "peers": [
            "AMGN", "GILD", "VRTX", "REGN", "BIIB", "MRNA", "BNTX", "ALNY",
            "SGEN", "BMRN", "INCY", "EXAS", "NBIX", "UTHR", "TECH",
        ],
    },
    {
        "id": "pharma",
        "priority": 95,
        "keywords": [
            "drug manufacturers", "pharmaceuticals", "pharma",
            "specialty & generic",
        ],
        "exclude": ["biotech", "biotechnology", "distributors"],
        "peers": [
            "LLY", "JNJ", "ABBV", "MRK", "PFE", "BMY", "AZN", "NVO", "SNY",
            "GSK", "ZTS", "VTRS", "OGN",
        ],
    },
    {
        "id": "managed_care",
        "priority": 100,
        "keywords": [
            "healthcare plans", "health care plans", "managed care",
            "insurance—health",
        ],
        "exclude": [],
        "peers": ["UNH", "ELV", "CI", "CVS", "HUM", "CNC", "MOH", "OSCR"],
    },
    {
        "id": "med_devices",
        "priority": 95,
        "keywords": [
            "medical devices", "medical instruments", "diagnostics",
            "health information services",
        ],
        "exclude": ["distribution"],
        "peers": [
            "ABT", "TMO", "DHR", "ISRG", "SYK", "MDT", "BSX", "EW", "ZBH",
            "BDX", "BAX", "RMD", "DXCM", "ALGN", "HOLX", "IDXX", "IQV", "A",
        ],
    },
    {
        "id": "healthcare_facilities",
        "priority": 90,
        "keywords": [
            "medical care facilities", "hospitals", "healthcare facilities",
            "long-term care",
        ],
        "exclude": [],
        "peers": ["HCA", "UHS", "THC", "DVA", "ACHC", "ENSG", "SEM"],
    },
    # ── Energy ──────────────────────────────────────────────────────────────
    {
        "id": "oil_gas_eap",
        "priority": 95,
        "keywords": [
            "oil & gas e&p", "oil & gas exploration", "exploration & production",
            "oil & gas integrated",
        ],
        "exclude": ["equipment", "services", "midstream", "refining", "retail"],
        "peers": [
            "XOM", "CVX", "COP", "EOG", "OXY", "PXD", "DVN", "FANG", "HES",
            "MRO", "APA", "CTRA", "PR", "MTDR",
        ],
    },
    {
        "id": "oil_gas_midstream",
        "priority": 100,
        "keywords": ["oil & gas midstream", "midstream", "pipelines"],
        "exclude": [],
        "peers": ["WMB", "KMI", "OKE", "EPD", "ET", "MPLX", "TRGP", "PAA", "LNG"],
    },
    {
        "id": "oil_gas_services",
        "priority": 100,
        "keywords": [
            "oil & gas equipment", "oil & gas services", "oilfield services",
        ],
        "exclude": [],
        "peers": ["SLB", "HAL", "BKR", "FTI", "NOV", "CHX", "WHD", "HP"],
    },
    {
        "id": "refining",
        "priority": 100,
        "keywords": ["oil & gas refining", "refining & marketing"],
        "exclude": [],
        "peers": ["MPC", "PSX", "VLO", "DINO", "PBF", "CVI"],
    },
    # ── Industrials ─────────────────────────────────────────────────────────
    {
        "id": "aerospace_defense",
        "priority": 100,
        "keywords": ["aerospace", "defense"],
        "exclude": [],
        "peers": [
            "BA", "RTX", "LMT", "NOC", "GD", "HII", "TDG", "HEI", "LHX", "TXT",
            "HWM", "CW", "AXON",
        ],
    },
    {
        "id": "machinery",
        "priority": 90,
        "keywords": [
            "farm & heavy construction", "specialty industrial machinery",
            "industrial machinery", "agricultural equipment",
        ],
        "exclude": [],
        "peers": ["CAT", "DE", "PCAR", "CMI", "IR", "PH", "EMR", "ROK", "DOV", "ITW", "XYL", "IEX", "GGG"],
    },
    {
        "id": "rails_logistics",
        "priority": 95,
        "keywords": [
            "railroads", "integrated freight", "trucking", "logistics",
            "air freight", "shipping",
        ],
        "exclude": [],
        "peers": ["UNP", "CSX", "NSC", "CP", "CNI", "UPS", "FDX", "XPO", "ODFL", "JBHT", "CHRW", "EXPD"],
    },
    {
        "id": "electrical_equipment",
        "priority": 90,
        "keywords": [
            "electrical equipment", "industrial distribution",
            "building products", "conglomerates",
        ],
        "exclude": [],
        "peers": ["ETN", "EMR", "HON", "GE", "MMM", "TT", "CARR", "JCI", "AME", "ROK", "GNRC"],
    },
    {
        "id": "waste",
        "priority": 100,
        "keywords": ["waste management", "pollution"],
        "exclude": [],
        "peers": ["WM", "RSG", "WCN", "CLH", "CWST"],
    },
    # ── Materials ───────────────────────────────────────────────────────────
    {
        "id": "chemicals",
        "priority": 90,
        "keywords": ["chemicals", "specialty chemicals"],
        "exclude": ["mining", "steel", "gold"],
        "peers": ["LIN", "APD", "SHW", "ECL", "DD", "DOW", "PPG", "LYB", "CE", "ALB", "FMC", "IFF"],
    },
    {
        "id": "metals_mining",
        "priority": 90,
        "keywords": ["copper", "gold", "silver", "steel", "aluminum", "other industrial metals", "coking coal"],
        "exclude": [],
        "peers": ["FCX", "NEM", "GOLD", "NUE", "STLD", "CLF", "X", "AA", "SCCO", "VALE", "BHP", "RIO"],
    },
    {
        "id": "construction_materials",
        "priority": 95,
        "keywords": ["building materials", "lumber", "construction materials"],
        "exclude": [],
        "peers": ["VMC", "MLM", "SUM", "EXP", "CRH", "JHX"],
    },
    # ── Real Estate / Utilities ─────────────────────────────────────────────
    {
        "id": "reit_industrial",
        "priority": 90,
        "keywords": ["reit—industrial", "industrial reit", "specialty reit"],
        "exclude": [],
        "peers": ["PLD", "EQIX", "DLR", "PSA", "EXR", "AMT", "CCI", "SBAC", "IRM"],
    },
    {
        "id": "reit_retail",
        "priority": 90,
        "keywords": ["reit—retail", "retail reit", "shopping"],
        "exclude": [],
        "peers": ["SPG", "O", "REG", "KIM", "FRT", "BRX", "NNN"],
    },
    {
        "id": "reit_residential",
        "priority": 90,
        "keywords": ["reit—residential", "residential reit", "apartment"],
        "exclude": [],
        "peers": ["AVB", "EQR", "ESS", "MAA", "UDR", "CPT", "INVH", "AMH"],
    },
    {
        "id": "utilities_electric",
        "priority": 90,
        "keywords": [
            "utilities—regulated electric", "utilities - regulated electric",
            "electric utilities", "diversified utilities",
        ],
        "exclude": ["water", "gas"],
        "peers": ["NEE", "SO", "DUK", "AEP", "EXC", "D", "SRE", "XEL", "PEG", "ED", "WEC", "ETR", "ES", "DTE", "PCG", "EIX"],
    },
    {
        "id": "utilities_water_gas",
        "priority": 95,
        "keywords": [
            "utilities—regulated water", "utilities—regulated gas",
            "water utilities", "gas utilities",
        ],
        "exclude": [],
        "peers": ["AWK", "WTRG", "CWT", "ATO", "NI", "SWX", "OGS"],
    },
]


# Broad sector fallbacks — used ONLY when industry group is unknown.
# Prefer more "core" liquid large-caps than the old mega-mix that mixed
# retail, tech platforms, and autos into one Technology basket.
_SECTOR_FALLBACK: dict[str, list[str]] = {
    "Technology": [
        "MSFT", "AAPL", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "CSCO",
        "ACN", "IBM", "INTU", "NOW", "QCOM", "TXN", "AMAT", "ADI", "PANW",
    ],
    "Communication Services": [
        "GOOGL", "META", "NFLX", "DIS", "TMUS", "VZ", "T", "CMCSA", "CHTR",
        "EA", "TTWO", "WBD", "LYV", "SPOT",
    ],
    "Consumer Cyclical": [
        "AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "BKNG", "TJX",
        "CMG", "MAR", "HLT", "ORLY", "ROST", "F", "GM",
    ],
    "Consumer Discretionary": [
        "AMZN", "TSLA", "HD", "MCD", "NKE", "LOW", "SBUX", "BKNG", "TJX",
        "CMG", "MAR", "HLT", "ORLY", "ROST", "F", "GM",
    ],
    "Consumer Defensive": [
        "WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "TGT",
        "KMB", "STZ", "GIS", "KHC", "KDP",
    ],
    "Consumer Staples": [
        "WMT", "COST", "PG", "KO", "PEP", "PM", "MO", "MDLZ", "CL", "TGT",
        "KMB", "STZ", "GIS", "KHC", "KDP",
    ],
    "Financial Services": [
        "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "BLK", "SPGI",
        "SCHW", "C", "PGR", "CB", "USB", "PNC",
    ],
    "Financials": [
        "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "BLK", "SPGI",
        "SCHW", "C", "PGR", "CB", "USB", "PNC",
    ],
    "Healthcare": [
        "UNH", "LLY", "JNJ", "ABBV", "MRK", "TMO", "ABT", "DHR", "AMGN",
        "PFE", "ISRG", "SYK", "ELV", "CI", "MDT", "BMY",
    ],
    "Health Care": [
        "UNH", "LLY", "JNJ", "ABBV", "MRK", "TMO", "ABT", "DHR", "AMGN",
        "PFE", "ISRG", "SYK", "ELV", "CI", "MDT", "BMY",
    ],
    "Energy": [
        "XOM", "CVX", "COP", "EOG", "SLB", "MPC", "PSX", "VLO", "OXY",
        "WMB", "KMI", "FANG", "DVN", "HES",
    ],
    "Industrials": [
        "HON", "RTX", "CAT", "GE", "UNP", "BA", "DE", "LMT", "UPS", "ETN",
        "WM", "NOC", "CSX", "ITW", "EMR", "FDX",
    ],
    "Real Estate": [
        "PLD", "AMT", "EQIX", "PSA", "CCI", "O", "SPG", "DLR", "WELL",
        "VICI", "AVB", "EQR", "SBAC", "EXR",
    ],
    "Utilities": [
        "NEE", "SO", "DUK", "AEP", "SRE", "D", "EXC", "XEL", "PEG", "ED",
        "WEC", "AWK", "ETR", "ES",
    ],
    "Basic Materials": [
        "LIN", "SHW", "APD", "FCX", "ECL", "NEM", "NUE", "DOW", "DD",
        "VMC", "MLM", "CTVA", "ALB",
    ],
    "Materials": [
        "LIN", "SHW", "APD", "FCX", "ECL", "NEM", "NUE", "DOW", "DD",
        "VMC", "MLM", "CTVA", "ALB",
    ],
}


def _norm(s: str | None) -> str:
    if not s:
        return ""
    t = str(s).lower().strip()
    t = t.replace("—", "-").replace("–", "-").replace("&", " and ")
    t = re.sub(r"\s+", " ", t)
    return t


def match_industry_group(industry: str | None, sector: str | None = None) -> dict | None:
    """Return the best curated industry group for this industry string."""
    ind = _norm(industry)
    if not ind or ind == "unknown":
        return None
    best = None
    best_score = -1
    for g in _INDUSTRY_GROUPS:
        # If any exclude token is present, this group is the wrong vertical
        # (e.g. "Semiconductor Equipment" must not land in pure chip designers).
        excluded = False
        for ex in (g.get("exclude") or []):
            en = _norm(ex)
            if en and en in ind:
                excluded = True
                break
        if excluded:
            continue
        score = 0
        for kw in g.get("keywords") or []:
            k = _norm(kw)
            if not k:
                continue
            if k == ind:
                score += 50
            elif k in ind or ind in k:
                score += 20 + min(len(k), 20)
        if score <= 0:
            continue
        score += int(g.get("priority") or 0)
        if score > best_score:
            best_score = score
            best = g
    return best


def market_cap_band(mcap: float | None) -> tuple[float, float]:
    """Allowed peer market-cap ratio band (low_mult, high_mult) vs subject.

    Sell-side desks keep peers in a comparable size sleeve; mega-caps only
    vs other mega/large, small-caps not vs $2T platforms.
    """
    if not mcap or mcap <= 0:
        return (0.15, 8.0)
    if mcap >= 200e9:          # mega
        return (0.15, 6.0)     # allow $30B+ peers for $200B+ names
    if mcap >= 50e9:           # large
        return (0.25, 4.0)
    if mcap >= 10e9:           # upper mid / lower large
        return (0.30, 3.5)
    if mcap >= 2e9:            # mid
        return (0.35, 3.0)
    return (0.40, 4.0)         # small — slightly wider


def size_score(subject_mcap: float | None, peer_mcap: float | None) -> float:
    """0–40: higher when peer market cap is closer (log distance)."""
    if not subject_mcap or not peer_mcap or subject_mcap <= 0 or peer_mcap <= 0:
        return 10.0  # neutral when unknown
    import math
    ratio = peer_mcap / subject_mcap
    lo, hi = market_cap_band(subject_mcap)
    if ratio < lo or ratio > hi:
        # Outside band — heavy penalty (still rankable as last resort)
        return max(0.0, 5.0 - abs(math.log10(ratio)) * 3.0)
    # Inside band: closer → higher
    dist = abs(math.log10(ratio))  # 0 = identical
    return max(0.0, 40.0 - dist * 35.0)


def in_size_band(subject_mcap: float | None, peer_mcap: float | None,
                 soft: bool = False) -> bool:
    if not subject_mcap or not peer_mcap or subject_mcap <= 0 or peer_mcap <= 0:
        return True  # don't drop when unknown
    lo, hi = market_cap_band(subject_mcap)
    if soft:
        lo *= 0.5
        hi *= 1.8
    ratio = peer_mcap / subject_mcap
    return lo <= ratio <= hi


def resolve_peer_tickers(
    ticker: str,
    sector: str | None = None,
    industry: str | None = None,
    *,
    subject_mcap: float | None = None,
    candidate_meta: Iterable[dict] | None = None,
    limit: int = 10,
    include_subject: bool = False,
) -> dict:
    """Pick sell-side-style comps for *ticker*.

    Parameters
    ----------
    candidate_meta : optional iterable of {symbol, sector, industry, market_cap?, revenue?}
        From security_meta / store. Used to prefer same-industry names already
        in the warehouse, scored with curated group membership.

    Returns
    -------
    {
      peers: [str, ...],          # ordered best-first, no subject
      group_id: str | None,
      group_label: str | None,
      method: "industry_group" | "industry_store" | "sector_fallback" | "mixed",
      scores: {TK: float},
    }
    """
    target = (ticker or "").strip().upper()
    group = match_industry_group(industry, sector)
    curated = []
    if group:
        curated = [p.upper() for p in (group.get("peers") or []) if p]

    # Store candidates with same / related industry
    store_same_ind: list[str] = []
    store_same_sec: list[str] = []
    mcaps: dict[str, float] = {}
    ind_norm = _norm(industry)
    sec_norm = _norm(sector)

    for c in (candidate_meta or []):
        sym = (c.get("symbol") or c.get("ticker") or "").strip().upper()
        if not sym or sym == target:
            continue
        if c.get("market_cap"):
            try:
                mcaps[sym] = float(c["market_cap"])
            except (TypeError, ValueError):
                pass
        c_ind = _norm(c.get("industry"))
        c_sec = _norm(c.get("sector"))
        if ind_norm and c_ind and (c_ind == ind_norm or ind_norm in c_ind or c_ind in ind_norm):
            store_same_ind.append(sym)
        elif sec_norm and c_sec and c_sec == sec_norm:
            store_same_sec.append(sym)

    # Seed score map. Curated list order is a sell-side relevance prior
    # (first names are the ones MS/GS typically list first).
    scores: dict[str, float] = {}
    curated_rank: dict[str, int] = {s: i for i, s in enumerate(curated)}

    def bump(sym: str, pts: float):
        if not sym or (sym == target and not include_subject):
            return
        scores[sym] = scores.get(sym, 0.0) + pts

    for i, s in enumerate(curated):
        # Slight decay so list order breaks ties (NVDA before CRUS for semis)
        bump(s, 100.0 + max(0, 20 - i) * 0.5)
    for s in store_same_ind:
        bump(s, 80.0)
    # Sector store names only if we have thin industry coverage
    thin = len([s for s in scores if s != target]) < 4
    if thin or not group:
        for s in store_same_sec:
            bump(s, 25.0)

    # Sector fallback curated list
    if len(scores) < 5:
        sec_peers = None
        if sector:
            sec_peers = _SECTOR_FALLBACK.get(sector)
            if not sec_peers:
                for k, v in _SECTOR_FALLBACK.items():
                    if k.lower() == (sector or "").lower():
                        sec_peers = v
                        break
        if sec_peers:
            for i, s in enumerate(sec_peers):
                bump(s.upper(), (40.0 if not group else 20.0) + max(0, 10 - i) * 0.3)
                if s.upper() not in curated_rank:
                    curated_rank[s.upper()] = 100 + i

    # Size scoring (bonus; does not erase industry membership)
    for sym in list(scores.keys()):
        scores[sym] += size_score(subject_mcap, mcaps.get(sym))

    def _sort_key(s: str):
        return (-scores.get(s, 0.0), curated_rank.get(s, 500), s)

    ranked = sorted(scores.keys(), key=_sort_key)

    # Size filter: soft for curated industry-group members (sell-side still
    # puts NVDA next to INTC even though mcap ratio is extreme). Hard filter
    # only for non-curated sector dumps.
    if subject_mcap and not group:
        tight = [s for s in ranked
                 if s == target or in_size_band(subject_mcap, mcaps.get(s), soft=False)
                 or mcaps.get(s) is None]
        if len([s for s in tight if s != target]) >= max(4, limit // 2):
            ranked = tight
        else:
            soft = [s for s in ranked
                    if s == target or in_size_band(subject_mcap, mcaps.get(s), soft=True)
                    or mcaps.get(s) is None]
            if len([s for s in soft if s != target]) >= 3:
                ranked = soft
    elif subject_mcap and group:
        # Keep all curated; size-filter only pure store/sector fillers
        kept = []
        for s in ranked:
            if s == target:
                kept.append(s)
                continue
            if s in curated_rank and curated_rank[s] < 40:
                kept.append(s)  # always keep top curated industry peers
            elif in_size_band(subject_mcap, mcaps.get(s), soft=True) or mcaps.get(s) is None:
                kept.append(s)
        if len([s for s in kept if s != target]) >= 4:
            ranked = kept

    peers = [s for s in ranked if s != target][: max(1, min(int(limit), 20))]

    if group and any(p in curated for p in peers):
        method = "industry_group"
    elif store_same_ind:
        method = "industry_store"
    elif any(scores.get(p, 0) >= 40 for p in peers):
        method = "sector_fallback"
    else:
        method = "mixed"

    return {
        "peers": peers,
        "group_id": (group or {}).get("id"),
        "group_label": industry or (group or {}).get("id"),
        "method": method,
        "scores": {p: round(scores.get(p, 0.0), 1) for p in peers},
        "industry": industry,
        "sector": sector,
    }


def format_peer_rationale(result: dict) -> str:
    """One-line note for UI / report injection."""
    method = result.get("method") or ""
    gid = result.get("group_id")
    if method == "industry_group" and gid:
        return f"Sell-side style peers · industry group `{gid}`"
    if method == "industry_store":
        return "Peers matched on GICS industry in store + size"
    if method == "sector_fallback":
        return "Industry thin — sector large-cap fallback (size-filtered)"
    return "Mixed industry/sector peer selection"
