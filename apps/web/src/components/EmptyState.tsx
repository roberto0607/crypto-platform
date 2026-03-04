interface EmptyStateProps {
  message?: string;
}

export default function EmptyState({
  message = "No data to display",
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
      <p className="text-sm">{message}</p>
    </div>
  );
}
