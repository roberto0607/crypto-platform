import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { searchPlayers, type PublicPlayer } from "@/api/endpoints/users";

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 250;

type Status = "idle" | "loading" | "done" | "error" | "limited";

const STATUS_MESSAGES: Partial<Record<Status, string>> = {
    loading: "Searching…",
    error: "Search isn't working right now. Try again.",
    limited: "Too many searches. Wait a moment.",
};

interface PlayerSearchProps {
    value: PublicPlayer | null;
    onChange: (player: PublicPlayer | null) => void;
}

/** Autocomplete for picking an opponent; a picked player becomes a chip. */
export function PlayerSearch({ value, onChange }: PlayerSearchProps) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<PublicPlayer[]>([]);
    const [status, setStatus] = useState<Status>("idle");
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const latestRequest = useRef(0);
    const listId = useId();

    useEffect(() => {
        const term = query.trim();
        const request = ++latestRequest.current;
        if (term.length < MIN_QUERY_LENGTH) {
            setResults([]);
            setStatus("idle");
            return;
        }
        setStatus("loading");
        const timer = setTimeout(async () => {
            try {
                const { data } = await searchPlayers(term);
                if (request !== latestRequest.current) return;
                setResults(data.users);
                setActive(0);
                setStatus("done");
            } catch (err) {
                if (request !== latestRequest.current) return;
                const limited = (err as { response?: { status?: number } })?.response?.status === 429;
                setResults([]);
                setStatus(limited ? "limited" : "error");
            }
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query]);

    function pick(player: PublicPlayer) {
        onChange(player);
        setQuery("");
        setOpen(false);
    }

    function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
        if (e.key === "Escape") {
            setOpen(false);
            return;
        }
        if (!open || results.length === 0) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + step + results.length) % results.length);
        } else if (e.key === "Enter") {
            e.preventDefault();
            pick(results[active]!);
        }
    }

    if (value) {
        return (
            <div className="ar-ps-chip" data-testid="player-chip">
                <span className="ar-ps-name">{value.username}</span>
                <span className="ar-ps-rank">{value.tier} · {value.elo}</span>
                <button type="button" className="ar-ps-clear" aria-label="Clear player" onClick={() => onChange(null)}>
                    ×
                </button>
            </div>
        );
    }

    const showList = open && status === "done" && results.length > 0;
    const message = status === "done" && results.length === 0 ? "No players found" : STATUS_MESSAGES[status];

    return (
        <div className="ar-ps">
            <input
                className="ar-input"
                role="combobox"
                aria-label="Search player"
                aria-expanded={showList}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={showList ? `${listId}-${active}` : undefined}
                autoComplete="off"
                placeholder="Search player…"
                value={query}
                onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                onKeyDown={onKeyDown}
            />
            {showList && (
                <ul className="ar-ps-list" id={listId} role="listbox">
                    {results.map((player, i) => (
                        <li
                            key={player.id}
                            id={`${listId}-${i}`}
                            role="option"
                            aria-selected={i === active}
                            className={`ar-ps-option${i === active ? " active" : ""}`}
                            onMouseEnter={() => setActive(i)}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                pick(player);
                            }}
                        >
                            <span className="ar-ps-name">{player.username}</span>
                            <span className="ar-ps-rank">{player.tier} · {player.elo} · {player.wins}W–{player.losses}L</span>
                        </li>
                    ))}
                </ul>
            )}
            {open && !showList && message && <div className="ar-ps-list ar-ps-message">{message}</div>}
        </div>
    );
}
