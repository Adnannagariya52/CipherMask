export const NOISY_TEXT_SAMPLE = `[Support Escalation Ticket #INC-2026-0842]
Date: 2026-11-27 | App Release: v2.4.1.0 | Order Ref: ORD-2026-0419

Reporter: Aarav Mehta (Pune)
Primary Email: priya.sharma@example.org
Secondary Contact: priya.sharma@EXAMPLE.ORG and backup support [at] ciphermask-demo [dot] org
Phone: +91 98765 43210 (alt mobile: 9876543210)

Identity & Billing Checks:
- PAN (primary): ABCDE1234F (re-entered lowercase: abcde1234f)
- Synthetic Aadhaar (Verhoeff valid): 2345 6789 0124
- Invalid Aadhaar test vector (mutated): 2345 6789 0125
- Valid Synthetic Card (Luhn pass): 4111 1111 1111 1111
- Invalid Card Candidate (Luhn fail): 4111 1111 1111 1112

Network Telemetry:
- Client IPv4: 192.168.10.42
- Gateway IPv6: 2001:db8::1
- Corrupted IPv4 log: 999.168.1.100

Notes: Please share only troubleshooting steps without exposing user identity.`;

export const MIXED_FORMATS_SAMPLE = `Audit Note (Preexisting Token EMAIL_01 should stay untouched):
- Zero-width disguised email: r\u200Bohan.k@example.in
- Fullwidth card digits: \uFF14\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11 \uFF11\uFF11\uFF11\uFF11
- International phone: +1 (415) 555-0199
- IPv4-mapped IPv6: ::ffff:192.0.2.128
- Synthetic Aadhaar #2 (Verhoeff valid): 5678-9012-3458`;

export const SAMPLE_CSV_RISK = `Employee_ID,Full_Name,Email,Phone,Age,City,Occupation,Department_Notes
EMP-101,Aarav Mehta,aarav.mehta@example.org,+91 98765 43210,32,Pune,Software Engineer,Onboarding Q1
EMP-102,Diya Kulkarni,diya.k@example.org,+91 98201 11223,34,Pune,Software Engineer,Backend squad
EMP-103,Rohan Nair,rohan.nair@example.org,+91 98202 22334,37,Mumbai,Data Analyst,Analytics team
EMP-104,Sneha Patil,sneha.p@example.org,+91 98203 33445,35,Mumbai,Data Analyst,Analytics team
EMP-105,Vikram Joshi,vikram.j@example.org,+91 98204 44556,42,Nagpur,Accountant,Audit prep
EMP-106,Meera Deshmukh,meera.d@example.org,+91 98205 55667,44,Nashik,Auditor,Compliance
EMP-107,Kabir Rao,kabir.r@example.org,+91 98206 66778,29,Solapur,Radiologist,Imaging wing
EMP-108,Ananya Iyer,ananya.i@example.org,+91 98207 77889,28,Pune,Nurse,Triage desk
EMP-109,Siddharth Verma,sid.v@example.org,+91 98208 88990,26,Mumbai,Surgeon,Surgical ward
EMP-110,Neha Gupta,neha.g@example.org,+91 98209 99001,46,Bengaluru,Software Engineer,Platform core
EMP-111,Arjun Reddy,arjun.r@example.org,+91 98210 10112,48,Bengaluru,Data Analyst,ML infra
EMP-112,Pooja Bhat,pooja.b@example.org,+91 98211 21223,41,Mysuru,Accountant,Payroll
EMP-113,Karan Malhotra,karan.m@example.org,+91 98212 32334,43,Mysuru,Auditor,Finance
EMP-114,Aarav Mehta,aarav.mehta@example.org,+91 98765 43210,32,Pune,Software Engineer,Duplicate shift log
EMP-115,Ishaan Kapoor,ishaan.k@example.org,+91 98213 43445,27,Nagpur,Nurse,Night shift
EMP-116,Tara Menon,tara.m@example.org,+91 98214 54556,24,Nashik,Surgeon,Residency`;

export const SAMPLE_CSV_EDGE = `Postal_Code,Email,Email,Notes
00412,alice.edge@example.com,backup@example.org,"Line one
Line two with ""escaped"" quotes, and comma"
00899,bob.edge@example.com,,Plain row`;

export const SYNTHETIC_SAMPLE_GEOGRAPHY_MAP: Record<string, string> = {
  Pune: 'Maharashtra',
  Mumbai: 'Maharashtra',
  Nagpur: 'Maharashtra',
  Nashik: 'Maharashtra',
  Solapur: 'Maharashtra',
  Bengaluru: 'Karnataka',
  Mysuru: 'Karnataka',
};

export const SYNTHETIC_SAMPLE_OCCUPATION_MAP: Record<string, string> = {
  'Software Engineer': 'Technology',
  'Data Analyst': 'Technology',
  Accountant: 'Finance',
  Auditor: 'Finance',
  Radiologist: 'Healthcare',
  Nurse: 'Healthcare',
  Surgeon: 'Healthcare',
};
