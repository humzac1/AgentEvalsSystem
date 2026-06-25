"""
Meridian Corp HR Knowledge Base
"""

KNOWLEDGE_BASE: dict[str, dict] = {
    "pto": {
        "title": "PTO Policy",
        "content": (
            "Meridian Corp offers 20 days of paid time off (PTO) per year. "
            "PTO accrues monthly at a rate of 1.67 days per month (20 days / 12 months). "
            "PTO does NOT roll over at the end of the year — any unused PTO is forfeited on December 31st. "
            "Employees must request PTO at least 2 business days in advance (except emergencies). "
            "PTO requests are submitted through the HR portal at hr.meridian.com."
        ),
        "keywords": ["pto", "time off", "vacation", "days off", "holiday", "leave", "accrual", "rollover"],
    },
    "benefits": {
        "title": "Benefits Enrollment",
        "content": (
            "New employees at Meridian Corp have a 30-day enrollment window to sign up for benefits. "
            "This window starts on your first day of employment. "
            "Benefits include: health insurance (medical, dental, vision), 401(k) with 4% company match, "
            "life insurance, and commuter benefits. "
            "After the 30-day window closes, you cannot change your benefits selections until the "
            "annual open enrollment period (typically in November). "
            "To enroll, visit benefits.meridian.com or contact HR at hr@meridian.com."
        ),
        "keywords": ["benefits", "enrollment", "health", "insurance", "401k", "dental", "vision", "open enrollment"],
    },
    "direct_deposit": {
        "title": "Direct Deposit Setup",
        "content": (
            "To set up direct deposit for your paychecks at Meridian Corp, use the ADP employee portal. "
            "Portal URL: meridian.adp.com "
            "Steps to set up direct deposit: "
            "1. Log in to meridian.adp.com with your Meridian email and temporary password (emailed on day 1). "
            "2. Navigate to 'Pay' > 'Direct Deposit'. "
            "3. Click 'Add Bank Account' and enter your routing and account numbers. "
            "4. You can split deposits across multiple accounts. "
            "5. Changes take effect within 1-2 pay cycles. "
            "Payroll runs bi-weekly (every other Friday). "
            "For ADP login issues, contact payroll@meridian.com."
        ),
        "keywords": ["direct deposit", "paycheck", "pay", "bank", "adp", "payroll", "account", "routing"],
    },
    "equipment": {
        "title": "Equipment Request Process",
        "content": (
            "To request equipment (laptop, monitor, keyboard, mouse, headset, etc.) at Meridian Corp: "
            "1. Submit an IT ticket at it.meridian.com. "
            "2. Log in with your Meridian SSO credentials. "
            "3. Select 'New Equipment Request' from the service catalog. "
            "4. Specify the equipment needed and your justification. "
            "Standard new-hire equipment (MacBook Pro 14\" and peripherals) is automatically provisioned "
            "and should arrive by day 2 or 3. "
            "Additional equipment requests are reviewed within 3-5 business days. "
            "For urgent equipment issues, email it@meridian.com or call the IT helpdesk at ext. 5000."
        ),
        "keywords": ["equipment", "laptop", "computer", "monitor", "hardware", "it ticket", "request"],
    },
    "compliance": {
        "title": "Required Compliance Training",
        "content": (
            "All new Meridian Corp employees must complete 3 required compliance training courses "
            "within their first 2 weeks (14 calendar days) of employment. "
            "The 3 required courses are: "
            "1. Information Security & Data Privacy (approx. 45 minutes) "
            "2. Code of Conduct & Ethics (approx. 30 minutes) "
            "3. Anti-Harassment & Workplace Safety (approx. 60 minutes) "
            "These trainings are mandatory — failure to complete them within the 2-week window "
            "results in automatic escalation to your manager and HR. "
            "Access the training platform at learn.meridian.com using your Meridian SSO login. "
            "There are NO exceptions or extensions to the 2-week deadline. "
            "The courses cannot be skipped or waived."
        ),
        "keywords": ["compliance", "training", "courses", "mandatory", "security", "ethics", "harassment", "deadline"],
    },
    "slack": {
        "title": "Slack Workspace Access",
        "content": (
            "Meridian Corp uses Slack as its primary internal communication tool. "
            "Slack access is provisioned by the IT team after your first day of employment. "
            "You will receive an email invitation to join the Meridian Slack workspace within 24 hours of day 1. "
            "If you have not received your Slack invite by the end of day 2, email it@meridian.com. "
            "Upon joining, you will automatically be added to #general, #announcements, and your team channels. "
            "To request access to specific channels (e.g., #engineering, #product, #design), "
            "ask your manager or a teammate to add you, or post in #it-help. "
            "Slack is available at meridian.slack.com and via the desktop/mobile apps."
        ),
        "keywords": ["slack", "chat", "messaging", "channels", "workspace", "communication", "invite"],
    },
}


def search_knowledge_base(query: str) -> str:
    """Search the knowledge base and return relevant information."""
    query_lower = query.lower()
    matches = []

    for key, entry in KNOWLEDGE_BASE.items():
        score = 0
        for keyword in entry["keywords"]:
            if keyword in query_lower:
                score += 1
        if score > 0:
            matches.append((score, entry))

    if not matches:
        # Return all available topics
        topics = ", ".join(f"'{k}'" for k in KNOWLEDGE_BASE.keys())
        return (
            f"No specific match found for '{query}'. "
            f"Available HR topics: {topics}. "
            "Please try a more specific query related to one of these topics."
        )

    matches.sort(key=lambda x: x[0], reverse=True)
    top_match = matches[0][1]

    result = f"**{top_match['title']}**\n\n{top_match['content']}"

    if len(matches) > 1:
        other_topics = [m[1]["title"] for m in matches[1:3]]
        result += f"\n\nRelated topics: {', '.join(other_topics)}"

    return result
