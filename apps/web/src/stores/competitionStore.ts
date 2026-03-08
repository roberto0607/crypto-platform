import { create } from "zustand";
import {
    listCompetitions,
    getCompetition,
    getLeaderboard,
    joinCompetition as joinApi,
    withdrawFromCompetition as withdrawApi,
    listMyCompetitions,
    getCurrentWeeklyCompetition,
    getUserTier,
    getUserBadges,
} from "@/api/endpoints/competitions";
import type {
    Competition,
    LeaderboardEntry,
    UserCompetition,
    Badge,
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

    // Weekly / Tier / Badges
    currentWeekly: Competition | null;
    currentWeeklyJoined: boolean;
    userTier: string;
    userBadges: Badge[];
    weeklyLoading: boolean;

    // Actions
    fetchCompetitions: (params?: { status?: string; competition_type?: string; limit?: number; offset?: number }) => Promise<void>;
    fetchDetail: (id: string) => Promise<void>;
    fetchLeaderboard: (id: string) => Promise<void>;
    join: (id: string) => Promise<void>;
    withdraw: (id: string) => Promise<void>;
    fetchMyCompetitions: () => Promise<void>;
    fetchCurrentWeekly: () => Promise<void>;
    fetchUserTier: () => Promise<void>;
    fetchUserBadges: () => Promise<void>;
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
    currentWeekly: null,
    currentWeeklyJoined: false,
    userTier: "ROOKIE",
    userBadges: [],
    weeklyLoading: false,

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
            set({ detail: data.competition ?? (data as any).data ?? null });
        } finally {
            set({ detailLoading: false });
        }
    },

    async fetchLeaderboard(id) {
        set({ leaderboardLoading: true });
        try {
            const { data } = await getLeaderboard(id);
            set({ leaderboard: data.leaderboard ?? (data as any).data ?? [] });
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

    async fetchCurrentWeekly() {
        set({ weeklyLoading: true });
        try {
            const { data } = await getCurrentWeeklyCompetition();
            set({
                currentWeekly: data.competition,
                currentWeeklyJoined: data.joined,
                userTier: data.tier,
            });
        } finally {
            set({ weeklyLoading: false });
        }
    },

    async fetchUserTier() {
        try {
            const { data } = await getUserTier();
            set({ userTier: data.tier });
        } catch {}
    },

    async fetchUserBadges() {
        try {
            const { data } = await getUserBadges();
            set({ userBadges: data.badges });
        } catch {}
    },
}));
