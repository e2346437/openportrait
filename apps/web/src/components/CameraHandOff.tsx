import { Callout, CopyValue } from "@openportrait/ui";

export interface CameraConnect {
  hosts: string[];
  sftpPort: number;
  ftpPort: number;
}
export interface HandOffCamera {
  label: string;
  username: string;
  folder: string;
  password: string;
}

const PROTOCOL_LABEL = { sftp: "SFTP", ftps: "FTPS (explicit TLS)", ftp: "FTP" } as const;

/** The values to type into a camera, with the password shown once. Used when a camera login is created or its password reset. */
export function CameraHandOff({ protocol, connect, camera }: { protocol: "sftp" | "ftp" | "ftps"; connect: CameraConnect; camera: HandOffCamera }) {
  return (
    <div className="stack">
      <dl className="up-creds">
        <dt>Protocol</dt>
        <dd>{PROTOCOL_LABEL[protocol]}</dd>
        <dt>Server</dt>
        <dd>
          {connect.hosts.length ? (
            connect.hosts.map((h) => <CopyValue key={h} value={h} label="server address" />)
          ) : (
            <span>Your server's address on your home network, such as 192.168.1.20. Save it under Settings &gt; Internet access to see it here.</span>
          )}
        </dd>
        <dt>Port</dt>
        <dd>
          <CopyValue value={String(protocol === "sftp" ? connect.sftpPort : connect.ftpPort)} label="port" />
        </dd>
        <dt>Username</dt>
        <dd>
          <CopyValue value={camera.username} label="username" />
        </dd>
        <dt>Password</dt>
        <dd>
          <CopyValue value={camera.password} label="password" />
        </dd>
        <dt>Folder</dt>
        <dd>Leave empty, or enter /</dd>
      </dl>
      <Callout tone="warn" title="The password is shown only now">
        It isn't stored in a readable form. If it's lost, choose New password and the old one stops working for new sign-ins.
      </Callout>
      <Callout tone="info">
        Photos arrive in <code>Incoming/{camera.folder}</code>. The address above is for cameras on your network. A camera away from home needs a WireGuard link, or a port forwarded to this server.
      </Callout>
    </div>
  );
}

/** Plain text for pasting into a message to the person who will shoot. */
export function handOffText(protocol: string, connect: CameraConnect, camera: HandOffCamera): string {
  const port = protocol === "sftp" ? connect.sftpPort : connect.ftpPort;
  return [`Camera setup for ${camera.label}`, `Protocol: ${protocol.toUpperCase()}`, `Server: ${connect.hosts[0] ?? "(your server address)"}`, `Port: ${port}`, `Username: ${camera.username}`, `Password: ${camera.password}`, "Folder: leave empty"].join("\n");
}
