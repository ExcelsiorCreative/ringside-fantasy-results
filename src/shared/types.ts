// Shapes passed from the ingestion runner to the Worker's /ingest endpoint.

export type Promotion = 'WWE' | 'AEW' | 'TNA' | 'NXT';
export type Result = 'win' | 'loss' | 'draw' | 'no_contest';
export type Finish = 'pinfall' | 'submission' | 'dq' | 'countout' | 'no_contest' | 'draw' | 'stoppage' | 'forfeit' | 'other' | 'unknown';
export type TitleOutcome = 'none' | 'retained' | 'changed' | 'vacated' | 'unknown';
export type MatchType = 'singles' | 'tag' | 'trios' | 'multi' | 'handicap' | 'battle_royal' | 'royal_rumble' | 'elimination_chamber' | 'mitb_ladder' | 'other';

export interface ParsedParticipant {
  raw: string;              // name as written by the source
  linkTarget?: string;      // wiki link target, when there was one
  wrestler_id?: string;     // filled in after alias matching
  side: number;
  result: Result;
  champion_going_in: boolean; // marked (c) by the source
  lost_by_dq_or_interference?: boolean;
  mitb_entered?: boolean;
  chamber_entered?: boolean;
  rumble_entry?: number | null;
  rumble_eliminations?: number | null;
  rumble_place?: number | null;
}

export interface ParsedMatch {
  match_number: number;
  is_main_event: boolean;
  pre_show: boolean;
  match_type: MatchType;
  stipulation: string;
  is_qualifier: boolean;
  is_tournament: boolean;
  finish: Finish;
  title_name: string | null;     // display text of the championship, if a title match
  title_championship_id?: string | null;
  title_outcome: TitleOutcome;
  cash_in?: { wrestler_raw: string; success: boolean } | null;
  participants: ParsedParticipant[];
  raw_text: string;
  /** reasons this match can't be published automatically */
  problems: string[];
  confidence: number; // 0..1
}

export interface ParsedShow {
  source: string;            // 'wikipedia'
  source_event_id: string;   // stable per source (page id + night)
  source_url: string;
  promotion: Promotion;
  name: string;
  show_type: 'weekly' | 'ple' | 'special';
  date: string;              // YYYY-MM-DD (local)
  local_start_time: string | null;
  time_zone: string | null;
  matches: ParsedMatch[];
  content_hash: string;
  problems: string[];
}

export interface TitleHolderFact {
  championship_id: string;
  holder_names: string[];
  holder_ids?: string[];
  as_of: string;           // YYYY-MM-DD
  source: string;
  source_url: string;
}

export interface IngestBatch {
  run: { id: string; source: string; started_at: string; pages_fetched: number; errors: string[] };
  shows: ParsedShow[];
  title_holders: TitleHolderFact[];
  unknown_names: { raw: string; normalized: string; source_url: string }[];
  finish?: boolean; // last batch of the run: finalize ingestion_runs row
}

export interface LookupData {
  aliases: [string, string][];            // [alias_search, wrestler_id]
  names: Record<string, string>;           // wrestler_id -> display name
  stables: { name_search: string; members: string[] }[];
  championships: { id: string; name: string; name_search: string; promotion: string; gender: string; holders_per_reign: number; wiki_page: string | null; holders: string[] }[];
  show_hashes: Record<string, string>;     // show id -> content_hash
  config: Record<string, string>;
}
