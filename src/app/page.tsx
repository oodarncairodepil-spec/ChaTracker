export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <div className="z-10 max-w-5xl w-full items-center justify-center font-mono text-sm lg:flex flex-col gap-4">
        <h1 className="text-4xl font-bold">WalleTracker 🤖💰</h1>
        <p className="text-xl">The bot is up and running!</p>
        <div className="p-4 bg-gray-100 dark:bg-neutral-800 rounded-lg">
          <p>Webhook URL: <code className="bg-gray-200 dark:bg-neutral-700 px-1 rounded">/api/telegram/webhook</code></p>
        </div>
        <p className="text-gray-500">Go to Telegram to interact with your bot.</p>
      </div>
    </main>
  )
}
