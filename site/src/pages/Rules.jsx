import { Link } from "react-router-dom";
import { useT } from "../i18n.jsx";
import { getPublicStats, ACTIVE_NETWORK, CONTRACT_ADDRESSES } from "../web3.js";
import { int, useChain } from "../components/liveUtils.js";
import { LINKS } from "../components/Layout.jsx";
import { usePageTitle } from "../meta.js";

// Every number here is the version 9 contracts' own. If a contract can
// report a number, it is read live.
export default function Rules() {
  const { t } = useT();
  usePageTitle(t("Rules"), t("How Sakartvelo Exchange works: citizens, share auctions, elections, the treasury and dividends, as the contracts on Arbitrum One enforce them."));
  const [stats] = useChain(getPublicStats, []);
  const maxCit = stats ? int(stats.maxCitizens) : "300,000";

  return (
    <div className="page" style={{ paddingTop: 48 }}>
      <article className="prose">
        <h1 className="h1">{t("Rules")}</h1>
        <p className="lede">{t("These are the rules the contracts enforce, in plain words. If this page and the contracts ever disagree, the contracts win; their source is public and verified.")}</p>
        <p className="muted">{t("This is version 9, live since 14 October 2026.")}</p>

        <h2 className="h2">{t("What is real")}</h2>
        <p>{t("The process is real. Every claim, bid, vote and payment is a transaction on {network} that anyone can check. The companies are fictional, named after real Georgian places and industries. INVEST is given free and has no value when issued. If it later becomes freely tradable, it may get a market price set by demand alone; nobody guarantees that, and it is not an investment product.", { network: ACTIVE_NETWORK.label })}</p>
        <p>{t("No single person can move value out of a company, and nobody, the site administrator included, can move anyone's INVEST or shares.")}</p>

        <h2 className="h2">{t("What the site administrator can do")}</h2>
        <p>{t("The site administrator can list companies, approve tokens for company treasuries, change the citizen limit, choose who may verify citizens, and switch whether INVEST can be sent between wallets, including freezing it. Because the administrator chooses the verifiers, they could also, in principle, create new citizens and with them new INVEST.")}</p>
        <p>{t("These powers go through a public timelock: a change is scheduled first, anyone can see it, and it can only take effect 48 hours later.")}</p>
        <p>{t("Two powers are instant. The administrator can pause new citizens, which stops new wallets from verifying and touches nothing else. And through the contracts of the earlier version 8, which still hold INVEST's trading switch, the administrator can make INVEST freely transferable for everyone at once; that can't be undone the same way.")}</p>
        {CONTRACT_ADDRESSES.SakartveloTimelock && (
          <p><a href={`${ACTIVE_NETWORK.blockExplorerUrls[0]}/address/${CONTRACT_ADDRESSES.SakartveloTimelock}`} target="_blank" rel="noreferrer">{t("See every scheduled change on Arbiscan")}</a></p>
        )}

        <h2 className="h2">{t("Risks, and how they are handled")}</h2>
        <dl className="stack-sm">
          <div><dt className="strong">{t("One person, many wallets.")}</dt><dd style={{ margin: 0 }}>{t("Verification checks a wallet's balance, not who owns it, so one person can verify several wallets. To slow this down, only ordinary wallets can verify, each needs 0.0083 ETH, at most 50 can verify an hour, and new verifications can be paused. A real privatization would need real identity checks.")}</dd></div>
          <div><dt className="strong">{t("A rich buyer taking over a company.")}</dt><dd style={{ margin: 0 }}>{t("Someone with a lot of INVEST can buy a majority. They can't do it quickly or quietly: a round sells at most 150 shares, every bid is public, and everyone in a round pays the same price. Whatever they pay becomes the company's capital, which they can't take back out without the shareholders' vote.")}</dd></div>
          <div><dt className="strong">{t("A CEO misusing company money.")}</dt><dd style={{ margin: 0 }}>{t("The CEO can only propose. Every payment, sale or investment is voted on by shareholders, the CEO can't vote on their own proposal, an approved proposal waits 5 days before it runs, at most 20% of a bucket can be spent per term, and shareholders can vote the CEO out.")}</dd></div>
          <div><dt className="strong">{t("Bugs in the contracts.")}</dt><dd style={{ margin: 0 }}>{t("The contracts were reviewed in several rounds by AI agents, every finding was fixed and tested, and the full record is public. There has been no paid external audit. The contracts can't be upgraded, so the code you see on Arbiscan is the code that runs.")}</dd></div>
          <div><dt className="strong">{t("Losing your wallet, or being scammed.")}</dt><dd style={{ margin: 0 }}>{t("Nobody can recover a lost wallet or reverse a transaction, the site administrator included. Keep your secret phrase offline. Nobody from this project will ever ask for it.")}</dd></div>
        </dl>
        <p><a href={LINKS.security} target="_blank" rel="noreferrer">{t("Read the full security review")}</a></p>

        <h2 className="h2">{t("The life of a company")}</h2>
        <ol>
          <li>{t("It is listed with a fixed number of shares and a round length.")}</li>
          <li>{t("Its shares are sold in rounds to the bidders who pay the most per share, until all are sold.")}</li>
          <li>{t("Once half the shares are sold, shareholders elect a CEO.")}</li>
          <li>{t("The CEO runs the company for 30 days and proposes what it pays, sells and invests; shareholders vote on each proposal.")}</li>
          <li>{t("After every term, shareholders vote on a dividend, and a new election can start.")}</li>
        </ol>

        <h2 className="h2">{t("Citizens and INVEST")}</h2>
        <p>{t("A wallet becomes a citizen by verifying itself: only ordinary wallets can, the contract checks that it holds at least 0.0083 ETH on {network} (nothing is taken), and at most 50 wallets an hour can verify. Each citizen then claims 1,000 INVEST, once. There are {max} citizen places.", { network: ACTIVE_NETWORK.label, max: maxCit })}</p>
        <p>{t("This makes creating wallets cost something, but one person can still verify several. Telling people apart needs real identity checks, which this simulation doesn't have.")}</p>
        <p>{t("INVEST can be sent between wallets. That was unlocked on 9 October 2026, in an experiment with version 8 whose plan and results are published.")} <a href={LINKS.experiment} target="_blank" rel="noreferrer">{t("Read about the experiment")}</a></p>

        <h2 className="h2">{t("Share auctions")}</h2>
        <p>{t("Each company sells its shares in rounds of a fixed length, up to 150 shares a round. A bid is an amount of INVEST plus, if you want, the most you'll pay for one share. Each wallet has one bid per company, of at least 1 INVEST, and a company holds at most 100 bids. When the book is full, a new bid must offer a higher price per share than the lowest, which is refunded.")}</p>
        <p>{t("When a round ends, anyone can settle it:")}</p>
        <ul>
          <li>{t("If every bid fits, the lowest bid's price per share is the price, and every bid buys as many whole shares as it can at that price.")}</li>
          <li>{t("If more shares are wanted than offered, the price is the highest at which the bids still want every share on offer, and the shares are shared out in proportion.")}</li>
          <li>{t("A bid whose price limit is below the round's price buys nothing that round.")}</li>
          <li>{t("Each bid pays only for its shares. A bid that got all it could is closed and the rest refunded; a bid that got some keeps the rest for the next round.")}</li>
          <li>{t("Of what is paid, 99% becomes the company's capital and 1% goes to the host.")}</li>
          <li>{t("The next round opens an hour after settlement. During that hour nobody can bid and anyone can withdraw their bid. When the last share is sold, every remaining bid is refunded.")}</li>
        </ul>
        <p>{t("Shares are tokens (NFTs) in the holder's wallet. Each can be moved or sold 7 days after it was issued. Holders can offer shares for sale at their own price on the share market. Nobody can send shares to a company.")}</p>

        <h2 className="h2">{t("Elections")}</h2>
        <p>{t("Once half of a company's shares are sold, anyone can open an election. Shares count as they were one day before it opened, and a wallet only counts with the shares it still holds, so borrowing shares for a vote gains nothing.")}</p>
        <ol>
          <li>{t("For 5 days, shareholders with at least 0.1% of the shares stand as candidates with a written program, and every shareholder can back one candidate with their shares. The 20 candidates with the most backing make the ballot. A candidate others have backed can't withdraw.")}</li>
          <li>{t("Then anyone opens 3 days of voting. Each shareholder votes for one candidate on the ballot, or against all of them.")}</li>
          <li>{t("A candidate wins with the votes of at least 20% of the shares and 51% of the votes cast. With only two candidates left, more votes than the other and than “against all” is enough.")}</li>
          <li>{t("Otherwise, if more than two candidates are left and at least 20% of the shares voted, the top two go to a runoff. If not, the round fails; after two failed rounds the election ends and a new one can be opened.")}</li>
        </ol>

        <h2 className="h2">{t("The CEO and recall")}</h2>
        <p>{t("A CEO serves one 30-day term. They act through an operating key: a separate wallet they name, which must accept, and which stops working when the term ends.")}</p>
        <p>{t("Shareholders can remove a CEO early. A holder of at least 1% of the shares opens a 3-day recall vote; it passes if a third of the shares vote and 51% of the votes say remove. A CEO can never vote shares their company holds elsewhere for themself or on their own recall.")}</p>

        <h2 className="h2">{t("The treasury")}</h2>
        <p>{t("Each company's money is kept in two parts: capital, raised by selling shares and from gifts, and income, which shareholders choose to reinvest at the end of a term. The CEO can't take anything out alone. Everything is a proposal shareholders vote on:")}</p>
        <ul>
          <li>{t("a payment to a named address, which can't be the CEO or the operating key;")}</li>
          <li>{t("a sale at a sealed-bid auction with a minimum price (2 days of sealed bids, 1 day to reveal, the highest bid wins; 1% of the winning bid goes to the host);")}</li>
          <li>{t("an investment of income in another company's share auction, with a maximum price per share. The CEO then receives 1% of the shares it buys, locked for 60 days.")}</li>
        </ul>
        <p>{t("A proposal is voted on for 3 days. It passes with yes votes from at least 20% of the shares that can vote and 51% of the votes cast; once this term's proposals pass 5% of the balance, it needs 40%. The CEO, the operating key and the recipient can't vote. No more than 20% of a balance can go out in one term.")}</p>
        <p>{t("An approved proposal waits 5 days before it can be carried out, so shareholders can recall the CEO first. A recall, or the end of the term, cancels anything not yet carried out.")}</p>

        <h2 className="h2">{t("Dividends")}</h2>
        <p>{t("After each term, anyone can open a 3-day vote on 1% of the company's INVEST capital: pay it to shareholders as a dividend, or move it to income for reinvesting. The winning side needs 20% of the shares that can vote; otherwise nothing happens. Voting and payout use the shares held when the term ended, and that term's CEO can't vote.")}</p>

        <h2 className="h2">{t("How this was checked")}</h2>
        <p>{t("Version 9 was written to fix the weaknesses found in version 8 and reviewed three times by AI auditors that had not written it, with attack tests on a local chain that copies Arbitrum's limits. Every problem they confirmed was fixed and has a test. It has not been audited by a paid external firm.")} <a href={LINKS.security} target="_blank" rel="noreferrer">{t("Read the security review")}</a></p>

        <p style={{ marginTop: 48 }}><Link to="/" className="btn btn-secondary">{t("Back to the register")}</Link></p>
      </article>
    </div>
  );
}
