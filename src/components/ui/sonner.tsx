import { Toaster as Sonner, type ToasterProps } from 'sonner'

/** shadcn-style Sonner toaster: bottom right, brand blue, errors in the fail color. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: 'group toast !rounded-inner !border-0 !bg-brand !p-4 !text-white !shadow-xl !font-sans',
          title: '!text-base !font-semibold',
          description: '!text-sm !text-white/85',
          error: '!bg-down',
          icon: '!text-white',
          actionButton: '!bg-white !text-canvas',
        },
      }}
      {...props}
    />
  )
}
