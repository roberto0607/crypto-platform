import { Link } from "react-router-dom";

export default function NotFoundPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-950 text-gray-300">
      <h1 className="text-6xl font-bold text-gray-500 mb-2">404</h1>
      <p className="text-lg mb-6">Page not found</p>
      <Link
        to="/dashboard"
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
