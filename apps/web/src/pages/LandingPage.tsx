import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listCompetitions } from "@/api/endpoints/competitions";
import type { Competition } from "@/api/endpoints/competitions";

export default function LandingPage() {
    const [competitions, setCompetitions] = useState<Competition[]>([]);

    useEffect(() => {
        listCompetitions({ status: "ACTIVE", limit: 3 })
            .then(({ data }) => setCompetitions(data.competitions))
            .catch(() => {}); // Non-fatal
    }, []);

    return (
        <div className="min-h-screen bg-gray-950 text-white">
            {/* Hero */}
            <div className="max-w-5xl mx-auto px-6 pt-20 pb-16 text-center">
                <h1 className="text-5xl font-bold mb-6 leading-tight">
                    Paper Trade Crypto.
                    <br />
                    <span className="text-blue-400">Compete. Win.</span>
                </h1>
                <p className="text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
                    Trade BTC, ETH, and SOL with $100k in virtual money. Join competitions,
                    climb the leaderboard, and prove your trading skills — risk free.
                </p>
                <div className="flex gap-4 justify-center">
                    <Link
                        to="/register"
                        className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-3 rounded-lg text-lg font-medium transition-colors"
                    >
                        Start Trading
                    </Link>
                    <Link
                        to="/login"
                        className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-8 py-3 rounded-lg text-lg font-medium transition-colors"
                    >
                        Sign In
                    </Link>
                </div>
            </div>

            {/* How it works */}
            <div className="max-w-4xl mx-auto px-6 py-16">
                <h2 className="text-2xl font-bold text-center mb-12">How It Works</h2>
                <div className="grid md:grid-cols-4 gap-8 text-center">
                    {[
                        { step: "1", title: "Register", desc: "Create a free account in seconds" },
                        { step: "2", title: "Join", desc: "Enter a competition or trade free play" },
                        { step: "3", title: "Trade", desc: "Buy and sell BTC, ETH, SOL" },
                        { step: "4", title: "Win", desc: "Climb the leaderboard by return %" },
                    ].map((item) => (
                        <div key={item.step}>
                            <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4 text-lg font-bold">
                                {item.step}
                            </div>
                            <h3 className="text-white font-semibold mb-2">{item.title}</h3>
                            <p className="text-gray-500 text-sm">{item.desc}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Active competitions preview */}
            {competitions.length > 0 && (
                <div className="max-w-4xl mx-auto px-6 py-16">
                    <h2 className="text-2xl font-bold text-center mb-8">Active Competitions</h2>
                    <div className="grid gap-4">
                        {competitions.map((c) => (
                            <div
                                key={c.id}
                                className="bg-gray-900 border border-gray-800 rounded-lg p-5"
                            >
                                <div className="flex items-center justify-between mb-2">
                                    <h3 className="text-lg font-semibold text-white">{c.name}</h3>
                                    <span className="text-green-400 text-xs bg-green-900/30 px-2 py-1 rounded">
                                        ACTIVE
                                    </span>
                                </div>
                                {c.description && (
                                    <p className="text-gray-400 text-sm mb-3">{c.description}</p>
                                )}
                                <div className="flex gap-6 text-xs text-gray-500">
                                    <span>
                                        Ends {new Date(c.end_at).toLocaleDateString()}
                                    </span>
                                    <span>
                                        ${Number(c.starting_balance_usd).toLocaleString()} starting balance
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="text-center mt-6">
                        <Link
                            to="/register"
                            className="text-blue-400 hover:underline text-sm"
                        >
                            Register to join competitions
                        </Link>
                    </div>
                </div>
            )}

            {/* Footer */}
            <div className="border-t border-gray-800 mt-16">
                <div className="max-w-4xl mx-auto px-6 py-8 text-center text-gray-600 text-sm">
                    Paper Trading Competition Platform — All trading uses virtual funds
                </div>
            </div>
        </div>
    );
}
