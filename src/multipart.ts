import type { Request, Response, NextFunction } from "express";

export type UploadedFile = {
  fieldname: string;
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
};

declare global {
  namespace Express {
    interface Request {
      uploadedFile?: UploadedFile | null;
    }
  }
}

function parseDisposition(header: string) {
  const nameMatch = /name="([^"]+)"/i.exec(header);
  const fileMatch = /filename="([^"]*)"/i.exec(header);
  return {
    name: nameMatch?.[1] ?? "",
    filename: fileMatch ? fileMatch[1] : null,
  };
}

/** Single-file multipart middleware. Populates req.body fields and optional req.uploadedFile. */
export function singleFileUpload(fieldName: string, maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      next();
      return;
    }
    const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (!boundary) {
      res.status(400).send("Missing multipart boundary");
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes + 1024 * 1024) {
        res.status(413).send("Payload too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const parts = splitMultipart(buf, boundary);
        const body: Record<string, string> = {};
        let uploaded: UploadedFile | null = null;
        for (const part of parts) {
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd < 0) continue;
          const headerText = part.subarray(0, headerEnd).toString("utf8");
          let content = part.subarray(headerEnd + 4);
          if (content.length >= 2 && content.subarray(content.length - 2).toString() === "\r\n") {
            content = content.subarray(0, content.length - 2);
          }
          const disp = /content-disposition:\s*(.+)/i.exec(headerText)?.[1] || "";
          const { name, filename } = parseDisposition(disp);
          if (!name) continue;
          if (filename !== null) {
            if (name === fieldName) {
              if (content.length > maxBytes) {
                res.status(400).send("File exceeds size limit");
                return;
              }
              const mime =
                /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() || "application/octet-stream";
              uploaded = {
                fieldname: name,
                originalname: filename,
                mimetype: mime,
                buffer: content,
                size: content.length,
              };
            }
          } else {
            body[name] = content.toString("utf8");
          }
        }
        req.body = { ...(req.body || {}), ...body };
        req.uploadedFile = uploaded;
        next();
      } catch (err) {
        next(err);
      }
    });
    req.on("error", next);
  };
}

function splitMultipart(buf: Buffer, boundary: string): Buffer[] {
  const delim = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = indexOf(buf, delim, 0);
  while (start >= 0) {
    start += delim.length;
    if (buf[start] === 45 && buf[start + 1] === 45) break; // --
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const end = indexOf(buf, delim, start);
    if (end < 0) break;
    parts.push(buf.subarray(start, end - 2 >= start ? end - 2 : end));
    start = end;
  }
  return parts;
}

function indexOf(hay: Buffer, needle: Buffer, from: number) {
  return hay.indexOf(needle, from);
}
