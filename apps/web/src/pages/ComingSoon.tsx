import { EmptyState, PageHeader, Panel, type IconName } from "@openportrait/ui";

const areas: Record<string, { title: string; icon: IconName; lede: string; detail: string }> = {
  leads: { title: "Leads", icon: "lead", lede: "Inquiries from your contact form and booking pages.", detail: "Track each inquiry through your own pipeline stages and turn it into a booked shoot in one step." },
  shoots: { title: "Shoots", icon: "camera", lede: "Every job, from booking to delivery.", detail: "Each shoot gets a subject, date, and type, its own folder on your gallery share, plus questionnaires, contracts, and orders." },
  calendar: { title: "Calendar", icon: "calendar", lede: "Shoots, appointments, and time off in one place.", detail: "Two-way sync with Google Calendar, so bookings never collide with the rest of your life." },
  clients: { title: "Clients", icon: "users", lede: "Everyone you've worked with.", detail: "Contacts, households, notes, and a timeline of every email, payment, shoot, and gallery view." },
  orders: { title: "Quotes & orders", icon: "receipt", lede: "Packages, quotes, invoices, and payments.", detail: "Send quotes clients can accept online, take PayPal payments on a schedule, and apply credits and coupons." },
  galleries: { title: "Galleries", icon: "image", lede: "Client galleries fed straight from your exports.", detail: "Export from Lightroom or Aftershoot into a shoot's Gallery folder and the photos appear here, ready to publish." },
  incoming: { title: "Incoming", icon: "inbox", lede: "Photos sent from your camera.", detail: "Your camera uploads over SFTP as you shoot. Sort the files into each shoot's RAW folder, or import them straight into Lightroom." },
};

export function ComingSoonPage({ area }: { area: keyof typeof areas }) {
  const a = areas[area]!;
  return (
    <>
      <PageHeader title={a.title} description={a.lede} />
      <Panel>
        <EmptyState icon={a.icon} title="This part of OpenPortrait is being built">
          {a.detail}
        </EmptyState>
      </Panel>
    </>
  );
}
