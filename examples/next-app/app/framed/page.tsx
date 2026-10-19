import { ClientLeaf } from '../../fixtures/ClientLeaf.tsx'

// The route `FramedRoute` loads into its frame.
export default function FramedPage() {
  return (
    <div data-fixture="framed-page">
      <ClientLeaf label="Inside a framed route." />
    </div>
  )
}
