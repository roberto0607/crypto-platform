import { create } from "zustand";
import {
    listCompetitions,
    getCompetition,
    getLeaderboard,
    joinCompetition as joinApi,
    withdrawFromCompetition as withdrawApi,
    listMyCompetitions,
} from "@/api/endpoints/competitions";
import type {
    Competition,
    LeaderboardEntry,
    UserCompetition,
} from "@/api/endpoints/competitions";

interface CompetitionState {
    // List page
    competitions: Competition[];
    total: number;
    listLoading: boolean;

    // Detail page
    detail: Competition | null;
    detailLoading: boolean;
    leaderboard: LeaderboardEntry[];
    leaderboardLoading: boolean;

    // User's competitions
    myCompetitions: UserCompetition[];
    myLoading: boolean;

    // Actions
    fetchCompetitions: (params?: { status?: string; limit?: number; offset?: number }) => Promise<void>;
    fetchDetail: (id: string) => Promise<void>;
    fetchLeaderboard: (id: string) => Promise<void>;
    join: (id: string) => Promise<void>;
    withdraw: (id: string) => Promise<void>;
    fetchMyCompetitions: () => Promise<void>;
}

export const useCompetitionStore = create<CompetitionState>((set) => ({
    competitions: [],
    total: 0,
    listLoading: false,
    detail: null,
    detailLoading: false,
    leaderboard: [],
    leaderboardLoading: false,
    myCompetitions: [],
    myLoading: false,

    async fetchCompetitions(params) {
        set({ listLoading: true });
        try {
            const { data } = await listCompetitions(params);
            set({ competitions: data.competitions ?? (data as any).data ?? [], total: data.total ?? 0 });
        } finally {
            set({ listLoading: false });
        }
    },

    async fetchDetail(id) {
        set({ detailLoading: true });
        try {
            const { data } = await getCompetition(id);
            set({ detail: data.competition });
        } finally {
            set({ detailLoading: false });
        }
    },

    async fetchLeaderboard(id) {
        set({ leaderboardLoading: true });
        try {
            const { data } = await getLeaderboard(id);
            set({ leaderboard: data.leaderboard });
        } finally {
            set({ leaderboardLoading: false });
        }
    },

    async join(id) {
        await joinApi(id);
        const { data } = await getCompetition(id);
        set({ detail: data.competition });
    },

    async withdraw(id) {
        await withdrawApi(id);
        const { data } = await getCompetition(id);
        set({ detail: data.competition });
    },

    async fetchMyCompetitions() {
        set({ myLoading: true });
        try {
            const { data } = await listMyCompetitions();
            set({ myCompetitions: data.competitions ?? (data as any).data ?? [] });
        } finally {
            set({ myLoading: false });
        }
    },
}));
