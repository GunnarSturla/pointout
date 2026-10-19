import type { ReactNode } from 'react'
import '../../shared/styles.css'

export const metadata = { title: 'pointout — Next.js test bed' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
