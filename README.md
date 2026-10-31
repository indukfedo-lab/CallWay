# Loom

**Discover the world through your taste.**

Loom is a culturally intelligent AI recommendation assistant that helps people discover what to watch, listen to, read, eat, and explore. Instead of relying on a single favorite item or generic popularity-based suggestions, Loom brings together multiple cultural interests and uses **Qloo's taste graph** to find meaningful connections between them.

> Love Beyoncé, *Interstellar*, and The Weeknd? Ask Loom to recommend movies that connect with your taste.

## Live Demo

- **Try Loom:** https://call-way-qljh.vercel.app
- **Source code:** https://github.com/indukfedo-lab/CallWay

## What Loom Does

Loom turns natural-language conversations into personalized cultural discovery. Users can describe what they enjoy, provide multiple references, and ask for recommendations across supported categories.

### Key Features

- **Conversational recommendations** — Ask for recommendations using natural language instead of filling out filters or forms.
- **Multiple taste references** — Combine several interests in one request so recommendations are not based on just one selected reference.
- **Cross-category discovery** — Explore supported cultural domains such as music, movies, TV shows, books, restaurants and places, destinations, fashion and brands, podcasts, and video games.
- **Image-based discovery** — Upload an image, such as a movie poster, so Loom can identify a relevant cultural reference and use it in the recommendation flow. Image references can also be combined with text requests.
- **Conversational refinement** — Refine a previous result, request more recommendations, or switch to another category while keeping relevant conversation context.
- **Recommendation details** — Recommendation cards can include titles, images, descriptions, Qloo affinity information, and explainability signals when those are returned by Qloo.
- **Authentication and conversation history** — Supabase supports user authentication and saved conversations.

Recommendation coverage and the availability of images, descriptions, affinity values, and explainability details depend on the data returned by the connected services.

## How It Works

Loom combines language understanding with Qloo's cultural intelligence:

1. **Understand the request** — Groq interprets the user's message, identifies cultural references, determines the requested recommendation category, and recognizes whether the user is starting a new topic or refining an existing one.
2. **Resolve cultural entities** — Loom uses the Qloo Search API to resolve names and references into Qloo entities.
3. **Combine taste references** — Resolved entities and relevant taste signals are prepared for the recommendation request, allowing multiple references to contribute to the same discovery task.
4. **Generate recommendations** — Loom sends the request to Qloo Insights and formats the returned entities as recommendation cards.
5. **Explain when data is available** — Loom uses Qloo-provided affinity and explainability data where available. It does not treat general metadata as proof of an entity's contribution.
6. **Continue the conversation** — Follow-up messages can refine the current request, ask for more results, or explore another category using the conversation context.

For image-based requests, Loom identifies a relevant cultural reference from the uploaded image and passes that reference into the same recommendation workflow.

## Technology Stack

| Technology | Role in Loom |
|---|---|
| **Next.js** | Web application and server-side API routes |
| **TypeScript** | Application and API logic |
| **Qloo API** | Entity search, cultural signals, and recommendation insights |
| **Groq** | Natural-language interpretation and conversation intent |
| **Supabase** | Authentication and conversation history |
| **Vercel** | Hosting and deployment |

## Qloo Integration

Qloo is the foundation of Loom's recommendation engine, not simply an additional data source.

- **Qloo Search** resolves user-provided interests into Qloo entities.
- **Qloo Insights** generates recommendations from the resolved interests and requested target category.
- **Taste and explainability signals** are used when supported by the API response to help describe how recommendations relate to the user's interests.

Loom uses the Qloo hackathon API:

```text
https://hackathon.api.qloo.com
```

Qloo requests are made from server-side API routes so the API key is not exposed to the browser.

## Getting Started

### Prerequisites

- Node.js compatible with the project's dependencies
- npm
- A Qloo API key with access to the hackathon API
- A Groq API key
- A Supabase project

### 1. Clone the repository

```bash
git clone https://github.com/indukfedo-lab/CallWay.git
cd CallWay
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env.local` file in the project root and add the credentials for your own services:

```env
QLOO_API_KEY=your_qloo_api_key
GROQ_API_KEY=your_groq_api_key
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
```

| Variable | Purpose |
|---|---|
| `QLOO_API_KEY` | Server-side authentication for Qloo API requests |
| `GROQ_API_KEY` | Server-side access for prompt interpretation |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL used by the application |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key used by the application |

Use the variable names exactly as shown. Do not add `NEXT_PUBLIC_` to secret server-side keys such as `QLOO_API_KEY` or `GROQ_API_KEY`. Never commit `.env.local` or publish API keys.

### 4. Configure Supabase

Use the Supabase project associated with your application. Configure the authentication providers you intend to use and add the local application URL and deployed application URL to the allowed authentication redirect URLs.

The application uses Supabase for authentication and conversation history. Make sure the database schema and access policies expected by the application are configured in your Supabase project.

### 5. Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project Structure

The main application areas include:

```text
app/
  api/
    chat/
      route.ts       # Conversation orchestration and recommendation workflow
    qloo/
      search/
        route.ts     # Qloo entity search and resolution
components/
  Main.tsx           # Main chat and recommendation experience
  Sidebar.tsx        # Navigation and conversation history
```

Other files provide the application layout, styling, authentication setup, and supporting UI components.

## Deployment

Loom is deployed on [Vercel](https://vercel.com/).

To deploy your own instance:

1. Import the GitHub repository into Vercel.
2. Select **Next.js** as the framework preset and use the repository root as the root directory.
3. Add the four environment variables listed above to the Vercel project settings.
4. Enable the variables for the environments you plan to use, such as Production and Preview.
5. Deploy the application.
6. Add the deployed domain and the required authentication callback URLs to your Supabase authentication settings.

Keep API keys in Vercel's server-side environment variables. Do not place secrets in client-side code or commit them to the repository.

## Security

- Keep `QLOO_API_KEY` and `GROQ_API_KEY` server-side.
- Do not commit `.env.local`, service-role keys, or other credentials.
- Use Supabase publishable keys only with appropriate database access policies and authorization checks.
- Avoid logging private user information or secrets.

## License

This project is licensed under the **MIT License**. See the [`LICENSE`](./LICENSE) file for details.

---

Built for the **Qloo Agentic Hackathon 2026 — Agents, but with taste.**

**Loom — Discover the world through your taste.**
