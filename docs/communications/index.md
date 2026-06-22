# Communications

Unify SMS and email delivery across Twilio, SendGrid, and MSG91 with automatic provider fallback.

## Problem

Twilio, SendGrid, and MSG91 each have completely different REST APIs, auth schemes, and error formats. If Twilio's SMS gateway hiccups at 2 AM during OTP delivery, users can't log in. Wiring up manual fallback means duplicating send logic and parsing three different error shapes to decide when to retry vs. fail over.

## Without Meridian

```typescript
import twilio from "twilio";
import axios from "axios";

const twilioClient = twilio(process.env.TWILIO_SID!, process.env.TWILIO_TOKEN!);

async function sendOTP(phone: string, otp: string) {
  try {
    await twilioClient.messages.create({
      body: `Your OTP is ${otp}`,
      from: process.env.TWILIO_FROM!,
      to: phone,
    });
  } catch (err: any) {
    if (err.status === 429 || err.status >= 500) {
      // Manually rewrite for MSG91's completely different API
      await axios.post("https://api.msg91.com/api/v5/otp", {
        template_id: process.env.MSG91_TEMPLATE!,
        mobile: phone,
        authkey: process.env.MSG91_KEY!,
        otp,
      });
    } else {
      throw err;
    }
  }
}
```

## With Meridian

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    twilio: {
      baseUrl: "https://api.twilio.com",
      auth: { username: process.env.TWILIO_SID!, password: process.env.TWILIO_TOKEN! },
      retry: { attempts: 2, backoff: "exponential" },
    },
    msg91: {
      baseUrl: "https://api.msg91.com",
      auth: { token: process.env.MSG91_KEY! },
      retry: { attempts: 2 },
    },
    sendgrid: {
      baseUrl: "https://api.sendgrid.com",
      auth: { token: process.env.SENDGRID_KEY! },
      retry: { attempts: 3, backoff: "exponential" },
    },
  },
  services: {
    sms:   { providers: ["twilio", "msg91"],            strategy: "failover" },
    email: { providers: ["sendgrid"],                   strategy: "failover" },
    comms: { providers: ["twilio", "msg91", "sendgrid"], strategy: "failover" },
  },
});

// SMS — Meridian tries Twilio, falls back to MSG91 automatically
const { data, meta } = await meridian.service("sms")!.post("/2010-04-01/Accounts/Messages.json", {
  body: { To: "+919876543210", Body: "Your OTP is 482910" },
});

console.log(meta.trace.provider);  // "msg91" if Twilio was down
console.log(meta.trace.retries);
```

## Production Example

OTP delivery that falls back from Twilio to MSG91, with audit logging:

```typescript
import { Meridian } from "meridianjs";

const meridian = await Meridian.create({
  localUnsafe: true,
  providers: {
    twilio: {
      baseUrl: "https://api.twilio.com",
      auth: { username: process.env.TWILIO_SID!, password: process.env.TWILIO_TOKEN! },
      retry: { attempts: 2, backoff: "exponential" },
    },
    msg91: {
      baseUrl: "https://api.msg91.com",
      auth: { token: process.env.MSG91_KEY! },
      retry: { attempts: 2 },
    },
    sendgrid: {
      baseUrl: "https://api.sendgrid.com",
      auth: { token: process.env.SENDGRID_KEY! },
      retry: { attempts: 3 },
    },
  },
  services: {
    sms:   { providers: ["twilio", "msg91"],  strategy: "failover" },
    email: { providers: ["sendgrid"],          strategy: "failover" },
  },
});

interface OTPRequest { phone: string; email: string; otp: string; userId: string; }

export async function deliverOTP({ phone, email, otp, userId }: OTPRequest) {
  let channel: "sms" | "email" = "sms";
  let meta: any;

  try {
    ({ meta } = await meridian.service("sms")!.post("/2010-04-01/Accounts/Messages.json", {
      body: { To: phone, Body: `Your OTP: ${otp}. Expires in 10 minutes.` },
    }));
  } catch {
    channel = "email";
    ({ meta } = await meridian.service("email")!.post("/v3/mail/send", {
      body: { to: [{ email }], subject: "Your OTP", content: [{ type: "text/plain", value: `Your OTP: ${otp}` }] },
    }));
  }

  console.log({ userId, channel, provider: meta.trace.provider, latency: meta.trace.latency });

  const health = meridian.health();
  if (health.twilio?.status === "down") console.error("Twilio is down — running on MSG91 only");

  return { channel, provider: meta.trace.provider };
}
```
