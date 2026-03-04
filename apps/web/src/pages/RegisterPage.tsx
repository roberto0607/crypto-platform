import { useState, useRef, useEffect, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AxiosError } from "axios";
import { useAppStore } from "@/stores/appStore";
import { register } from "@/api/endpoints/auth";
import { getSystemStatus } from "@/api/endpoints/status";
import { normalizeApiError } from "@/lib/errors";
import type { LegacyApiError, V1ApiError } from "@/types/api";
import Input from "@/components/Input";
import Button from "@/components/Button";
import ErrorBanner from "@/components/ErrorBanner";

export default function RegisterPage() {
  const navigate = useNavigate();
  const systemStatus = useAppStore((s) => s.systemStatus);
  const setSystemStatus = useAppStore((s) => s.setSystemStatus);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const betaMode = systemStatus?.betaMode ?? false;

  // Fetch system status on mount if not already loaded
  useEffect(() => {
    if (!systemStatus) {
      getSystemStatus()
        .then((res) => setSystemStatus(res.data))
        .catch(() => {});
    }
  }, [systemStatus, setSystemStatus]);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  function validate(): string | null {
    if (password.length < 8) return "Password must be at least 8 characters";
    if (password.length > 72) return "Password must be at most 72 characters";
    if (password !== confirmPassword) return "Passwords do not match";
    if (betaMode && !inviteCode.trim()) return "Invite code is required during beta";
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    try {
      await register(email, password, betaMode ? inviteCode.trim() : undefined);
      navigate("/login?registered=1", { replace: true });
    } catch (err) {
      const { message } = normalizeApiError(
        err as AxiosError<LegacyApiError | V1ApiError>,
      );
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <h1 className="text-2xl font-bold text-white text-center">
        Create account
      </h1>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Input
        ref={emailRef}
        id="email"
        label="Email"
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <Input
        id="password"
        label="Password"
        type="password"
        required
        minLength={8}
        maxLength={72}
        autoComplete="new-password"
        placeholder="Min 8 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <Input
        id="confirm-password"
        label="Confirm password"
        type="password"
        required
        minLength={8}
        maxLength={72}
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        error={
          confirmPassword && password !== confirmPassword
            ? "Passwords do not match"
            : undefined
        }
      />

      {betaMode && (
        <Input
          id="invite-code"
          label="Invite code"
          type="text"
          required
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
        />
      )}

      <Button type="submit" loading={submitting} className="w-full">
        Create account
      </Button>

      <p className="text-center text-sm text-gray-400">
        Already have an account?{" "}
        <Link to="/login" className="text-blue-400 hover:text-blue-300">
          Log in
        </Link>
      </p>
    </form>
  );
}
