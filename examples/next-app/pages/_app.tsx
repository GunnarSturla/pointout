import type { AppProps } from 'next/app'
import '../../shared/styles.css'

// The Pages Router allows global CSS only here.
export default function PagesApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
